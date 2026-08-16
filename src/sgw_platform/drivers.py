from __future__ import annotations

from sgw_platform.models import (
    Assessment,
    Asset,
    ChangeDriver,
    ConfidenceAssessment,
    ConsequenceAssessment,
    LikelihoodAssessment,
    RiskDriver,
)


TIER_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}


class DriverEngine:
    """Produces deterministic fact objects for UI and later narrative rendering."""

    def current(
        self,
        asset: Asset,
        likelihood: LikelihoodAssessment,
        consequence: ConsequenceAssessment,
        confidence: ConfidenceAssessment,
    ) -> tuple[RiskDriver, ...]:
        drivers: list[RiskDriver] = []
        if likelihood.components:
            strongest = max(likelihood.components, key=lambda item: item.points)
            drivers.append(RiskDriver(strongest.name, strongest.name.replace("_", " "), strongest.points, "points", "increases_likelihood"))
        if consequence.effective_population:
            drivers.append(RiskDriver("effective_population", "Effective residents exposed", consequence.effective_population, "residents", "increases_consequence"))
        if consequence.critical_facilities:
            drivers.append(RiskDriver("critical_facilities", "Critical facilities downstream", len(consequence.critical_facilities), "facilities", "increases_consequence"))
        if consequence.max_uncovered_hours:
            drivers.append(RiskDriver("uncovered_hours", "Uncovered backup gap", consequence.max_uncovered_hours, "hours", "increases_consequence"))
        if consequence.paths:
            resilience = min(path.resilience_factor for path in consequence.paths)
            drivers.append(RiskDriver("resilience_factor", "Alternate-supply resilience", resilience, None, "reduces_consequence" if resilience < 1 else "no_reduction"))
        if confidence.verification_actions:
            drivers.append(RiskDriver("unverified_readiness", "Unverified material readiness", len(confidence.verification_actions), "items", "reduces_confidence"))
        return tuple(drivers)

    def changes(self, previous: Assessment, current: Assessment) -> tuple[tuple[ChangeDriver, ...], str | None]:
        changes: list[ChangeDriver] = []
        self._numeric(changes, "restoration_hours", previous.restoration_hours, current.restoration_hours, "hours", "consequence")
        self._numeric(changes, "uncovered_hours", previous.max_uncovered_hours, current.max_uncovered_hours, "hours", "consequence")
        if current.direct_flood_sensitive:
            self._numeric(changes, "flood_depth_m", previous.flood_depth_m, current.flood_depth_m, "m", "likelihood")
        self._numeric(changes, "consequence_score", previous.consequence_score, current.consequence_score, "points", "risk")
        self._numeric(changes, "risk_score", previous.risk_score, current.risk_score, "points", "risk")
        self._numeric(changes, "confidence_score", previous.confidence_score, current.confidence_score, "points", "confidence")
        if previous.tier != current.tier:
            direction = "increased_risk" if TIER_ORDER[current.tier.value] > TIER_ORDER[previous.tier.value] else "decreased_risk"
            changes.append(ChangeDriver("risk_tier", previous.tier.value, current.tier.value, None, direction, f"Risk tier changed {previous.tier.value} to {current.tier.value}"))
        if previous.rank != current.rank:
            direction = "increased_priority" if current.rank is not None and previous.rank is not None and current.rank < previous.rank else "decreased_priority"
            changes.append(ChangeDriver("rank", previous.rank, current.rank, None, direction, f"Rank changed #{previous.rank} to #{current.rank}"))
        previous_verification = dict(previous.material_verification)
        current_verification = dict(current.material_verification)
        for asset_id in sorted(previous_verification.keys() | current_verification.keys()):
            before, after = previous_verification.get(asset_id), current_verification.get(asset_id)
            if before != after:
                impact = "increased_confidence" if after == "verified" else "decreased_confidence"
                changes.append(ChangeDriver("verification_status", before, after, None, impact, f"{asset_id} verification changed {before} to {after}"))
        return tuple(changes), self._primary(previous, current, changes)

    @staticmethod
    def _numeric(changes: list[ChangeDriver], metric: str, previous: float, current: float, unit: str, category: str) -> None:
        if round(previous, 3) == round(current, 3):
            return
        direction = "increased" if current > previous else "decreased"
        changes.append(ChangeDriver(metric, previous, current, unit, f"{direction}_{category}", f"{metric.replace('_', ' ').title()} changed {previous:g} to {current:g} {unit}"))

    @staticmethod
    def _primary(previous: Assessment, current: Assessment, changes: list[ChangeDriver]) -> str | None:
        if current.restoration_hours - previous.restoration_hours >= 2 and current.max_uncovered_hours - previous.max_uncovered_hours >= 2:
            service = current.limiting_service_id or "downstream service"
            return f"Expected restoration now exceeds {service}'s {current.limiting_backup_hours:g}h backup endurance."
        flood_change = next((change for change in changes if change.metric == "flood_depth_m" and change.current > change.previous), None)
        if flood_change:
            return f"Direct flood exposure increased from {flood_change.previous:g}m to {flood_change.current:g}m."
        verification = next((change for change in changes if change.metric == "verification_status"), None)
        if verification:
            return verification.summary + "."
        tier = next((change for change in changes if change.metric == "risk_tier"), None)
        if tier:
            return tier.summary + "."
        risk = next((change for change in changes if change.metric == "risk_score"), None)
        return risk.summary + "." if risk else None
