from __future__ import annotations

from sgw_platform.models import (
    Advisory,
    Asset,
    AssetState,
    LikelihoodAssessment,
    LikelihoodBand,
    LikelihoodComponent,
)


def _band(score: float) -> LikelihoodBand:
    if score >= 75:
        return LikelihoodBand.VERY_HIGH
    if score >= 50:
        return LikelihoodBand.HIGH
    if score >= 30:
        return LikelihoodBand.MODERATE
    return LikelihoodBand.LOW


class LikelihoodEngine:
    """Calculates asset disruption likelihood without considering consequence.

    Dependencies, downstream population, restoration duration, backup endurance,
    and alternate feeds intentionally do not enter this calculation.
    """

    MAX_SCORE = 98.0

    def assess(self, asset: Asset, state: AssetState, advisory: Advisory) -> LikelihoodAssessment:
        baseline = min(40.0, asset.disruption_baseline * 100)
        # The adapter supplies a location- and advisory-derived wind prediction.
        # Converting it back to the engine's 0-50 contribution keeps the domain
        # independent of any particular weather or mapping provider.
        storm = min(50.0, max(0.0, (state.wind_gust_kph - 35.0) / 95.0 * 50.0))
        condition = (100 - asset.condition_score) / 100 * 16
        if asset.attributes.get("flood_sensitive", False):
            direct_hazard = min(22.0, state.flood_depth_m * 20)
        elif asset.attributes.get("coastal_flood_exposure", False):
            direct_hazard = min(8.0, state.flood_depth_m * 8)
        else:
            direct_hazard = 0.0
        operational = {
            "operational": 0.0,
            "watch": 2.0,
            "degraded": 6.0,
            "failed": 10.0,
            "outage": 10.0,
        }.get(state.operational_status, 3.0)

        components = (
            LikelihoodComponent("baseline_susceptibility", round(baseline, 1), "Inherent design and reliability susceptibility"),
            LikelihoodComponent("local_storm_exposure", round(storm, 1), "Location-derived wind prediction for this advisory"),
            LikelihoodComponent("condition_penalty", round(condition, 1), "Penalty derived from the asset condition score"),
            LikelihoodComponent("direct_hazard_stress", round(direct_hazard, 1), "Direct flood stress for hazard-sensitive assets"),
            LikelihoodComponent("operational_stress", round(operational, 1), f"Current operational status is {state.operational_status}"),
        )
        raw_score = round(sum(component.points for component in components), 1)
        score = min(self.MAX_SCORE, max(0.0, raw_score))
        drivers = self._drivers(asset, state, advisory, components)
        return LikelihoodAssessment(advisory.advisory_id, asset.sgw_id, score, raw_score, _band(score), components, drivers)

    @staticmethod
    def _drivers(asset: Asset, state: AssetState, advisory: Advisory, components: tuple[LikelihoodComponent, ...]) -> tuple[str, ...]:
        ranked = sorted((component for component in components if component.points > 0), key=lambda item: item.points, reverse=True)
        drivers = [f"{item.name.replace('_', ' ')} contributes {item.points:.1f} points" for item in ranked[:3]]
        if asset.attributes.get("flood_sensitive", False) and state.flood_depth_m > 0:
            drivers.append(f"direct flood depth is {state.flood_depth_m:.2f}m")
        elif asset.attributes.get("coastal_flood_exposure", False) and state.flood_depth_m > 0:
            drivers.append(f"coastal flood depth is {state.flood_depth_m:.2f}m")
        if advisory.changes:
            relevant = [change for change in advisory.changes if change.get("asset_id") in {None, asset.sgw_id}]
            if relevant:
                drivers.append(f"{len(relevant)} relevant advisory update(s) received")
        return tuple(drivers)
