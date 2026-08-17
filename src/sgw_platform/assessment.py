from __future__ import annotations

from dataclasses import replace

from sgw_platform.graph import DependencyGraph
from sgw_platform.consequence import ConsequenceEngine
from sgw_platform.confidence import ConfidenceEngine
from sgw_platform.drivers import DriverEngine
from sgw_platform.likelihood import LikelihoodEngine
from sgw_platform.models import Advisory, Asset, AssetState, Assessment, RiskTier


def tier_for_score(score: float) -> RiskTier:
    """Prototype decision thresholds; these are not industry standards.

    Each boundary states a likelihood-and-consequence pairing rather than a
    round number, so the scale can be re-derived if either engine is retuned:

        critical  ~70% likelihood against a consequence of 80  -> 56
        high      ~55% likelihood against a consequence of 62  -> 34
        medium    ~45% likelihood against a consequence of 40  -> 18

    Recalibrated when the consequence population term stopped being normalised
    against a single asset's effective population; the boundaries moved with the
    scale, and the resulting tier distribution is unchanged.
    """
    if score >= 56: return RiskTier.CRITICAL
    if score >= 34: return RiskTier.HIGH
    if score >= 18: return RiskTier.MEDIUM
    return RiskTier.LOW


class AssessmentEngine:
    """Generic, dependency-aware calculation. It contains no scenario/asset IDs."""

    def __init__(
        self,
        likelihood_engine: LikelihoodEngine | None = None,
        consequence_engine: ConsequenceEngine | None = None,
        confidence_engine: ConfidenceEngine | None = None,
        driver_engine: DriverEngine | None = None,
    ):
        self.likelihood_engine = likelihood_engine or LikelihoodEngine()
        self.consequence_engine = consequence_engine or ConsequenceEngine()
        self.confidence_engine = confidence_engine or ConfidenceEngine()
        self.driver_engine = driver_engine or DriverEngine()

    def assess(
        self,
        assets: list[Asset],
        states: list[AssetState],
        advisory: Advisory,
        graph: DependencyGraph,
        previous: list[Assessment] | None = None,
    ) -> list[Assessment]:
        assets_by_id = {asset.sgw_id: asset for asset in assets}
        states_by_id = {state.sgw_id: state for state in states}
        results: list[Assessment] = []
        for asset in assets:
            state = states_by_id[asset.sgw_id]
            likelihood_result = self.likelihood_engine.assess(asset, state, advisory)
            likelihood = likelihood_result.score
            consequence_result = self.consequence_engine.assess(asset, assets_by_id, states_by_id, advisory, graph)
            confidence_result = self.confidence_engine.assess(asset, assets_by_id, states_by_id, advisory, graph, consequence_result)
            current_drivers = self.driver_engine.current(asset, likelihood_result, consequence_result, confidence_result)
            population = consequence_result.effective_population
            facilities = list(consequence_result.critical_facilities)
            consequence = consequence_result.score
            score = min(100, round(likelihood * consequence / 100, 1))
            notes = [f"{round(likelihood)}% disruption likelihood"]
            drivers: list[dict] = [{"type": "likelihood", "value": likelihood, "band": likelihood_result.band.value,
                                    "components": [{"name": component.name, "points": component.points} for component in likelihood_result.components]}]
            if population: notes.append(f"service path reaches {population:,} residents")
            if facilities: notes.append(f"downstream critical facilities: {', '.join(facilities)}")
            if population: drivers.append({"type": "community_impact", "population": population, "facilities": facilities})
            if state.restoration_hours:
                drivers.append({"type": "restoration", "hours": state.restoration_hours})
            drivers.append({"type": "consequence", "value": consequence,
                            "effective_population": consequence_result.effective_population,
                            "uncovered_hours": consequence_result.max_uncovered_hours,
                            "paths": len(consequence_result.paths)})
            limiting_path = max(consequence_result.paths, key=lambda path: path.uncovered_hours, default=None)
            material_ids = {asset.sgw_id, *(path.service_asset_id for path in consequence_result.paths)}
            material_verification = tuple(sorted(
                (item_id, states_by_id[item_id].verification_status)
                for item_id in material_ids if item_id in states_by_id
            ))
            results.append(Assessment(
                advisory.advisory_id, asset.sgw_id, likelihood, consequence, score,
                tier_for_score(score), population, tuple(facilities), tuple(notes),
                confidence=confidence_result.level.value,
                confidence_score=confidence_result.score,
                confidence_reasons=confidence_result.reasons,
                sufficient_data=confidence_result.sufficient_data,
                verification_actions=confidence_result.verification_actions,
                likelihood_source=likelihood_result.likelihood_source,
                experimental_ml_likelihood=likelihood_result.experimental_ml_likelihood,
                experimental_ml_band=likelihood_result.experimental_ml_band,
                experimental_ml_drivers=likelihood_result.experimental_ml_drivers,
                model_name=likelihood_result.model_name,
                model_version=likelihood_result.model_version,
                restoration_hours=state.restoration_hours,
                flood_depth_m=state.flood_depth_m,
                direct_flood_sensitive=bool(asset.attributes.get("flood_sensitive", False)),
                max_uncovered_hours=consequence_result.max_uncovered_hours,
                limiting_backup_hours=limiting_path.backup_hours if limiting_path else 0.0,
                limiting_service_id=limiting_path.service_asset_id if limiting_path else None,
                impacted_zone_ids=consequence_result.impacted_zone_ids,
                critical_facility_ids=consequence_result.critical_facility_ids,
                material_verification=material_verification,
                current_drivers=current_drivers,
                drivers=tuple(drivers),
            ))
        ordered = sorted(results, key=lambda item: (-item.risk_score, -item.consequence_score, -item.disruption_likelihood, item.sgw_id))
        previous_by_id = {item.sgw_id: item for item in previous or []}
        previous_ranks = {item.sgw_id: item.rank for item in previous or [] if item.rank is not None}
        ranked = []
        for index, item in enumerate(ordered, start=1):
            previous_rank = previous_ranks.get(item.sgw_id)
            rank_change = previous_rank - index if previous_rank is not None else None
            ranked_item = replace(item, rank=index, previous_rank=previous_rank, rank_change=rank_change)
            prior = previous_by_id.get(item.sgw_id)
            if prior:
                change_drivers, primary_change = self.driver_engine.changes(prior, ranked_item)
                ranked_item = replace(ranked_item, change_drivers=change_drivers, primary_change=primary_change)
            ranked.append(ranked_item)
        return ranked

    def assess_timeline(
        self,
        assets: list[Asset],
        advisories: list[Advisory],
        states_by_advisory: dict[str, list[AssetState]],
        graph: DependencyGraph,
    ) -> dict[str, list[Assessment]]:
        timeline: dict[str, list[Assessment]] = {}
        previous: list[Assessment] | None = None
        for advisory in advisories:
            current = self.assess(assets, states_by_advisory[advisory.advisory_id], advisory, graph, previous)
            timeline[advisory.advisory_id] = current
            previous = current
        return timeline
