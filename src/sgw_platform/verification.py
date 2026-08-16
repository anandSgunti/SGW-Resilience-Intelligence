"""Field verification: turns a recorded field result into new operational state.

This module owns exactly one responsibility — translating what a field team
observed into the `AssetState` fields the risk engines already read. It never
calculates risk, never approves work, and contains no scenario or asset ids.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from sgw_platform.models import (
    Assessment,
    AssetState,
    FieldOutcome,
    VerificationImpact,
    VerificationSnapshot,
)


@dataclass(frozen=True)
class OutcomeEffect:
    """Declarative mapping from a field outcome to observed operational state."""

    generator_status: str
    operational_status: str
    backup_policy: str  # "confirmed" | "reduced" | "none"
    label: str


class FieldVerificationEngine:
    """Applies a field outcome to an asset state and describes what moved."""

    EFFECTS = {
        FieldOutcome.VERIFIED_OPERATIONAL: OutcomeEffect(
            "operational", "operational", "confirmed", "confirmed operational readiness"
        ),
        FieldOutcome.VERIFIED_DEGRADED: OutcomeEffect(
            "degraded", "degraded", "reduced", "confirmed degraded readiness"
        ),
        FieldOutcome.UNAVAILABLE: OutcomeEffect(
            "unavailable", "degraded", "none", "confirmed the backup is unavailable"
        ),
    }

    NUMERIC_METRICS = (
        ("backup_available_hours", "hours", "backup endurance"),
        ("restoration_hours", "hours", "expected restoration"),
        ("max_uncovered_hours", "hours", "uncovered service gap"),
        ("disruption_likelihood", "%", "disruption likelihood"),
        ("consequence_score", "points", "consequence"),
        ("risk_score", "points", "systemic risk"),
        ("confidence_score", "points", "evidence confidence"),
    )

    def apply(
        self,
        state: AssetState,
        outcome: FieldOutcome,
        confirmed_backup_hours: float | None,
        reported_at: str,
        reported_by: str,
    ) -> AssetState:
        """Return the state a field team's result implies. Never mutates input."""
        effect = self.EFFECTS[outcome]
        if effect.backup_policy == "none":
            backup = 0.0
        elif confirmed_backup_hours is not None:
            backup = max(0.0, float(confirmed_backup_hours))
        elif effect.backup_policy == "reduced":
            backup = round((state.backup_available_hours or 0.0) / 2, 1)
        else:
            backup = state.backup_available_hours
        return replace(
            state,
            verification_status="verified",
            generator_status=effect.generator_status,
            operational_status=effect.operational_status,
            backup_available_hours=backup,
            reported_at=reported_at,
            reported_by=reported_by,
            source="field_verification",
        )

    @staticmethod
    def snapshot(state: AssetState, assessment: Assessment) -> VerificationSnapshot:
        return VerificationSnapshot(
            sgw_id=state.sgw_id,
            verification_status=state.verification_status,
            generator_status=state.generator_status,
            operational_status=state.operational_status,
            backup_available_hours=state.backup_available_hours,
            restoration_hours=state.restoration_hours,
            risk_score=assessment.risk_score,
            risk_tier=assessment.tier,
            consequence_score=assessment.consequence_score,
            disruption_likelihood=assessment.disruption_likelihood,
            confidence=assessment.confidence,
            confidence_score=assessment.confidence_score,
            max_uncovered_hours=assessment.max_uncovered_hours,
            rank=assessment.rank,
        )

    def impacts(
        self,
        before: tuple[VerificationSnapshot, ...],
        after: tuple[VerificationSnapshot, ...],
    ) -> tuple[VerificationImpact, ...]:
        """Describe every material movement the reassessment produced."""
        after_by_id = {item.sgw_id: item for item in after}
        results: list[VerificationImpact] = []
        for previous in before:
            current = after_by_id.get(previous.sgw_id)
            if current is None:
                continue
            results.extend(self._asset_impacts(previous, current))
        return tuple(results)

    def _asset_impacts(
        self, previous: VerificationSnapshot, current: VerificationSnapshot
    ) -> list[VerificationImpact]:
        results: list[VerificationImpact] = []
        for name, label in (
            ("verification_status", "evidence status"),
            ("generator_status", "generator status"),
            ("operational_status", "operational status"),
        ):
            before_value, after_value = getattr(previous, name), getattr(current, name)
            if before_value != after_value:
                results.append(VerificationImpact(
                    previous.sgw_id, name, before_value, after_value, None, "recorded",
                    f"{previous.sgw_id} {label} changed {before_value} to {after_value}",
                ))
        for name, unit, label in self.NUMERIC_METRICS:
            before_value, after_value = getattr(previous, name), getattr(current, name)
            if before_value is None or after_value is None or round(float(before_value), 3) == round(float(after_value), 3):
                continue
            direction = "increased" if after_value > before_value else "decreased"
            results.append(VerificationImpact(
                previous.sgw_id, name, before_value, after_value, unit, direction,
                f"{previous.sgw_id} {label} {direction} from {before_value:g} to {after_value:g}{unit if unit == '%' else ''}",
            ))
        if previous.risk_tier != current.risk_tier:
            results.append(VerificationImpact(
                previous.sgw_id, "risk_tier", previous.risk_tier.value, current.risk_tier.value, None,
                "reassessed", f"{previous.sgw_id} risk tier moved {previous.risk_tier.value} to {current.risk_tier.value}",
            ))
        if previous.confidence != current.confidence:
            results.append(VerificationImpact(
                previous.sgw_id, "confidence", previous.confidence, current.confidence, None,
                "reassessed", f"{previous.sgw_id} confidence moved {previous.confidence} to {current.confidence}",
            ))
        if previous.rank is not None and current.rank is not None and previous.rank != current.rank:
            results.append(VerificationImpact(
                previous.sgw_id, "rank", previous.rank, current.rank, None,
                "reprioritised", f"{previous.sgw_id} rank moved #{previous.rank} to #{current.rank}",
            ))
        return results

    def narrative(
        self,
        stage: str,
        recorded_at: str,
        verified_by: str,
        outcome: FieldOutcome,
        detail: str,
        before: VerificationSnapshot,
        after: VerificationSnapshot,
    ) -> str:
        """Preserve the before/after story in one operator-readable sentence."""
        clock = recorded_at[11:16] if len(recorded_at) >= 16 else recorded_at
        opening = (
            f"At {stage}, {before.sgw_id} readiness was {before.verification_status} "
            f"(reported {before.generator_status}, {_hours(before.backup_available_hours)} backup)."
        )
        middle = f" At {clock}, {verified_by} {self.EFFECTS[outcome].label}"
        if detail.strip():
            middle += f": {detail.strip().rstrip('.')}"
        middle += "."
        if after.backup_available_hours != before.backup_available_hours:
            middle += (
                f" Verified backup endurance moved from "
                f"{_hours(before.backup_available_hours)} to {_hours(after.backup_available_hours)}."
            )
        return opening + middle


def _hours(value: float | None) -> str:
    return "unknown" if value is None else f"{value:g}h"
