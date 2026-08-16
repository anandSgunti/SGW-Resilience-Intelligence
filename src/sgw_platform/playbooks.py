from __future__ import annotations

import hashlib
from dataclasses import replace
from datetime import datetime, timezone

from sgw_platform.models import (
    Advisory,
    Assessment,
    Asset,
    Recommendation,
    RecommendationEvent,
    RecommendationEvidence,
    RecommendationFact,
    RecommendationStatus,
    RiskTier,
    TriggerCondition,
)
from sgw_platform.rules import (
    CRITICAL_BACKUP_GAP_HOURS,
    DIRECT_FLOOD_DEPTH_M,
    assessment_source,
    rule,
)


ACTIVE_MITIGATION = {
    RecommendationStatus.APPROVED,
    RecommendationStatus.ASSIGNED,
    RecommendationStatus.IN_PROGRESS,
    RecommendationStatus.COMPLETED,
}


def _recommendation_id(rule_id: str, asset_id: str, advisory_id: str, target_id: str | None) -> str:
    identity = f"{rule_id}|{asset_id}|{advisory_id}|{target_id or ''}"
    return f"REC-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:12].upper()}"


def _compact(value: str) -> str:
    return value.replace("SGW-", "")


def _render(value: object, unit: str | None) -> str:
    text = f"{value:g}" if isinstance(value, (int, float)) and not isinstance(value, bool) else str(value)
    return f"{text}{unit}" if unit else text


def _condition(
    left_label: str, left_value: object, operator: str,
    right_label: str, right_value: object, unit: str | None = None,
) -> TriggerCondition:
    """One numeric comparison in operator language, never a code expression."""
    return TriggerCondition(
        summary=f"{left_label} {_render(left_value, unit)} {operator} {right_label} {_render(right_value, unit)}",
        left_label=left_label, left_value=left_value, operator=operator,
        right_label=right_label, right_value=right_value, unit=unit,
    )


def _state_condition(
    left_label: str, left_value: object, right_label: str, right_value: object,
) -> TriggerCondition:
    """One categorical check, phrased as observed-versus-required."""
    return TriggerCondition(
        summary=f"{left_label} is {left_value} · {right_label} {right_value}",
        left_label=left_label, left_value=left_value, operator="is",
        right_label=right_label, right_value=right_value, unit=None,
    )


class PlaybookEngine:
    """Deterministic rules recommend actions; this class never approves them."""

    FLOOD_THRESHOLD_M = DIRECT_FLOOD_DEPTH_M
    BACKUP_GAP_THRESHOLD_H = CRITICAL_BACKUP_GAP_HOURS

    def evaluate(
        self,
        assessments: list[Assessment],
        assets: dict[str, Asset],
        advisory: Advisory,
        existing: list[Recommendation] | None = None,
    ) -> list[Recommendation]:
        recommendations: list[Recommendation] = []
        existing = existing or []
        for assessment in assessments:
            asset = assets[assessment.sgw_id]
            source = _compact(assessment.sgw_id)
            if assessment.tier == RiskTier.CRITICAL and assessment.max_uncovered_hours > self.BACKUP_GAP_THRESHOLD_H and assessment.limiting_service_id:
                target = assessment.limiting_service_id
                recommendations.append(self._make(
                    "R1", assessment, advisory, target,
                    f"Pre-position temporary generation or alternate supply at {target}",
                    f"Expected restoration exceeds verified backup by {assessment.max_uncovered_hours:g} hours.",
                    (
                        RecommendationFact("restoration_hours", assessment.restoration_hours, "hours"),
                        RecommendationFact("backup_hours", assessment.limiting_backup_hours, "hours"),
                        RecommendationFact("uncovered_hours", assessment.max_uncovered_hours, "hours"),
                    ), RiskTier.CRITICAL,
                    (
                        _condition(f"{source} restoration", assessment.restoration_hours, ">",
                                   f"{_compact(target)} backup", assessment.limiting_backup_hours, "h"),
                        _condition(f"{source} uncovered gap", assessment.max_uncovered_hours, ">",
                                   "configured threshold", self.BACKUP_GAP_THRESHOLD_H, "h"),
                    ),
                ))

            if assessment.tier in {RiskTier.HIGH, RiskTier.CRITICAL} and assessment.verification_actions:
                unverified_ids = [item_id for item_id, status in assessment.material_verification if status != "verified"]
                for index, action in enumerate(assessment.verification_actions):
                    target = unverified_ids[index] if index < len(unverified_ids) else assessment.sgw_id
                    recommendations.append(self._make(
                        "R2", assessment, advisory, target, action,
                        "A material resilience fact remains unverified.",
                        (RecommendationFact("confidence", assessment.confidence), RecommendationFact("confidence_score", assessment.confidence_score, "points")),
                        RiskTier.HIGH,
                        (
                            _state_condition(f"{_compact(target)} readiness", "unverified", "required", "verified"),
                            _state_condition(f"{source} risk tier", assessment.tier.value, "rule scope", "high or critical"),
                        ),
                    ))

            if assessment.tier == RiskTier.CRITICAL and assessment.critical_facilities:
                recommendations.append(self._make(
                    "R3", assessment, advisory, assessment.sgw_id,
                    f"Prioritize inspection and escalation for {asset.name}",
                    f"Critical systemic risk exposes {len(assessment.critical_facilities)} critical facilities.",
                    (
                        RecommendationFact("critical_facilities", len(assessment.critical_facilities), "facilities"),
                        RecommendationFact("effective_population", assessment.affected_population, "residents"),
                    ), RiskTier.CRITICAL,
                    (
                        _condition(f"{source} downstream critical facilities", len(assessment.critical_facilities),
                                   ">=", "configured minimum", 1),
                        _state_condition(f"{source} risk tier", assessment.tier.value, "rule scope", "critical"),
                    ),
                ))

            if assessment.direct_flood_sensitive and assessment.flood_depth_m >= self.FLOOD_THRESHOLD_M:
                recommendations.append(self._make(
                    "R4", assessment, advisory, assessment.sgw_id,
                    f"Deploy flood protection and inspect {asset.name}",
                    f"Direct flood exposure exceeds the {self.FLOOD_THRESHOLD_M:g}m playbook threshold.",
                    (RecommendationFact("flood_depth_m", assessment.flood_depth_m, "m"), RecommendationFact("threshold_m", self.FLOOD_THRESHOLD_M, "m")),
                    RiskTier.HIGH if assessment.tier != RiskTier.CRITICAL else RiskTier.CRITICAL,
                    (
                        _condition(f"{source} direct flood depth", assessment.flood_depth_m, ">=",
                                   "configured threshold", self.FLOOD_THRESHOLD_M, "m"),
                    ),
                ))

            mitigation_assigned = any(item.asset_id == assessment.sgw_id and item.status in ACTIVE_MITIGATION for item in existing)
            if assessment.tier == RiskTier.CRITICAL and not mitigation_assigned:
                recommendations.append(self._make(
                    "R5", assessment, advisory, assessment.sgw_id,
                    f"Escalate unmitigated Critical risk for {asset.name}",
                    "No approved or active mitigation is assigned to this Critical assessment.",
                    (RecommendationFact("risk_score", assessment.risk_score, "points"), RecommendationFact("risk_tier", assessment.tier.value)),
                    RiskTier.CRITICAL,
                    (
                        _state_condition(f"{source} risk tier", assessment.tier.value, "rule scope", "critical"),
                        _state_condition(f"{source} mitigation cover", "none approved or active", "required", "at least one"),
                    ),
                ))
        return sorted(recommendations, key=lambda item: (item.asset_id, item.rule_id, item.target_asset_id or ""))

    @staticmethod
    def _evidence(
        assessment: Assessment,
        advisory: Advisory,
        trigger: tuple[TriggerCondition, ...],
    ) -> RecommendationEvidence:
        """Compact, code-free impact statement derived from the assessment."""
        items: list[str] = []
        if assessment.max_uncovered_hours:
            items.append(f"{assessment.max_uncovered_hours:g}h uncovered")
        items.extend(_compact(item) for item in assessment.impacted_zone_ids)
        items.extend(_compact(item) for item in assessment.critical_facility_ids)
        if not items:
            items.append(
                f"{assessment.affected_population:,} residents"
                if assessment.affected_population else "no modelled downstream service"
            )
        return RecommendationEvidence(
            trigger=trigger,
            impact_items=tuple(items),
            impact_summary=" · ".join(items),
            assessment_source=assessment_source(advisory.event_id, advisory.stage),
            advisory_id=advisory.advisory_id,
            assessed_tier=assessment.tier,
            assessed_risk_score=assessment.risk_score,
            state_reported_at=advisory.issued_at,
        )

    def _make(
        self,
        rule_id: str,
        assessment: Assessment,
        advisory: Advisory,
        target_id: str | None,
        title: str,
        reason: str,
        facts: tuple[RecommendationFact, ...],
        priority: RiskTier,
        trigger: tuple[TriggerCondition, ...],
    ) -> Recommendation:
        published = rule(rule_id)
        return Recommendation(
            _recommendation_id(rule_id, assessment.sgw_id, advisory.advisory_id, target_id),
            rule_id, assessment.sgw_id, target_id, advisory.advisory_id,
            title, reason, facts, priority, published.default_owner, published.action_class,
            rule=published,
            evidence=self._evidence(assessment, advisory, trigger),
        )


class RecommendationStore:
    """In-memory prototype state with validated transitions and immutable events."""

    ALLOWED = {
        RecommendationStatus.RECOMMENDED: {RecommendationStatus.APPROVED, RecommendationStatus.REJECTED},
        RecommendationStatus.APPROVED: {RecommendationStatus.ASSIGNED},
        RecommendationStatus.ASSIGNED: {RecommendationStatus.IN_PROGRESS},
        RecommendationStatus.IN_PROGRESS: {RecommendationStatus.COMPLETED},
        RecommendationStatus.REJECTED: {RecommendationStatus.RECOMMENDED},
        RecommendationStatus.COMPLETED: set(),
    }

    def __init__(self):
        self._items: dict[str, Recommendation] = {}

    def add(self, recommendation: Recommendation) -> Recommendation:
        if recommendation.recommendation_id in self._items:
            raise ValueError(f"Recommendation already exists: {recommendation.recommendation_id}")
        self._items[recommendation.recommendation_id] = recommendation
        return recommendation

    def list(self) -> list[Recommendation]:
        return list(self._items.values())

    def get(self, recommendation_id: str) -> Recommendation:
        return self._items[recommendation_id]

    def transition(
        self,
        recommendation_id: str,
        status: RecommendationStatus,
        actor: str,
        *,
        occurred_at: str | None = None,
        owner: str | None = None,
        reason: str | None = None,
    ) -> Recommendation:
        current = self.get(recommendation_id)
        if status not in self.ALLOWED[current.status]:
            raise ValueError(f"Invalid transition: {current.status.value} -> {status.value}")
        if not actor.strip():
            raise ValueError("A human actor is required")
        if status == RecommendationStatus.REJECTED and not reason:
            raise ValueError("A rejection reason is required")
        if status == RecommendationStatus.ASSIGNED and not owner:
            raise ValueError("An owner is required when assigning a recommendation")
        timestamp = occurred_at or datetime.now(timezone.utc).isoformat()
        event = RecommendationEvent(status, timestamp, actor, owner, reason)
        updated = replace(current, status=status, owner=owner or current.owner, history=current.history + (event,))
        self._items[recommendation_id] = updated
        return updated
