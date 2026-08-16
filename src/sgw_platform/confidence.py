from __future__ import annotations

from datetime import datetime

from sgw_platform.graph import DependencyGraph
from sgw_platform.models import (
    Advisory,
    Asset,
    AssetState,
    ConfidenceAssessment,
    ConfidenceComponent,
    ConfidenceLevel,
    ConsequenceAssessment,
)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _level(score: float) -> ConfidenceLevel:
    if score >= 90:
        return ConfidenceLevel.HIGH
    if score >= 65:
        return ConfidenceLevel.MEDIUM
    return ConfidenceLevel.LOW


class ConfidenceEngine:
    """Rates evidence quality without altering likelihood, consequence, or risk."""

    WEIGHTS = {"completeness": .30, "freshness": .25, "verification": .30, "source_agreement": .15}

    def assess(
        self,
        asset: Asset,
        assets: dict[str, Asset],
        states: dict[str, AssetState],
        advisory: Advisory,
        graph: DependencyGraph,
        consequence: ConsequenceAssessment,
    ) -> ConfidenceAssessment:
        state = states.get(asset.sgw_id)
        if state is None:
            return ConfidenceAssessment(
                advisory.advisory_id, asset.sgw_id, 0.0, ConfidenceLevel.LOW, False,
                (ConfidenceComponent("completeness", 0.0, "Operational state is missing"),),
                ("insufficient data for reliable assessment",),
                (f"Collect current operational state for {asset.name}",),
            )

        completeness, completeness_detail, sufficient = self._completeness(asset, state)
        freshness, freshness_detail = self._freshness(asset, state, advisory)
        verification, verification_detail, actions = self._verification(asset, assets, states, graph, consequence)
        agreement, agreement_detail = self._source_agreement(asset, graph, consequence)
        components = (
            ConfidenceComponent("completeness", completeness, completeness_detail),
            ConfidenceComponent("freshness", freshness, freshness_detail),
            ConfidenceComponent("verification", verification, verification_detail),
            ConfidenceComponent("source_agreement", agreement, agreement_detail),
        )
        score = round(sum(component.score * self.WEIGHTS[component.name] for component in components) * 100, 1)
        reasons = tuple(component.detail for component in components)
        if not sufficient:
            reasons += ("insufficient data for reliable assessment",)
        return ConfidenceAssessment(advisory.advisory_id, asset.sgw_id, score, _level(score), sufficient, components, reasons, actions)

    @staticmethod
    def _completeness(asset: Asset, state: AssetState) -> tuple[float, str, bool]:
        values = [asset.sgw_id, asset.latitude, asset.longitude, asset.condition_score, state.restoration_hours, state.reported_at, state.source]
        present = sum(value is not None and value != "" for value in values)
        score = present / len(values)
        sufficient = state.restoration_hours is not None and asset.latitude is not None and asset.longitude is not None
        return score, f"{present} of {len(values)} required identity and operational fields are present", sufficient

    @staticmethod
    def _freshness(asset: Asset, state: AssetState, advisory: Advisory) -> tuple[float, str]:
        issued = _parse_datetime(advisory.issued_at)
        reported = _parse_datetime(state.reported_at)
        if issued is None or reported is None:
            return 0.0, "operational-state freshness cannot be established"
        age_minutes = max(0.0, (issued - reported).total_seconds() / 60)
        if age_minutes <= 60:
            score = 1.0
        elif age_minutes <= 360:
            score = .75
        elif age_minutes <= 1440:
            score = .5
        else:
            score = .2
        inspection = _parse_datetime(asset.last_inspection_date)
        if inspection and (issued.date() - inspection.date()).days > 365:
            score = min(score, .5)
        return score, f"weather and operational state updated {age_minutes:.0f} minutes before this advisory"

    @staticmethod
    def _verification(
        asset: Asset,
        assets: dict[str, Asset],
        states: dict[str, AssetState],
        graph: DependencyGraph,
        consequence: ConsequenceAssessment,
    ) -> tuple[float, str, tuple[str, ...]]:
        material_ids = {asset.sgw_id, *(path.service_asset_id for path in consequence.paths)}
        unverified = sorted(item_id for item_id in material_ids if item_id in states and states[item_id].verification_status != "verified")
        dependency_nodes = material_ids | {path.zone_id for path in consequence.paths}
        dependency_verified = all(
            edge.verified for edge in graph.dependencies
            if edge.from_id in dependency_nodes or edge.to_id in dependency_nodes
        )
        actions = tuple(
            f"Verify {assets[item_id].name} generator and backup readiness"
            if assets[item_id].asset_type.value == "pump_station"
            else f"Verify current state for {assets[item_id].name}"
            for item_id in unverified
        )
        if unverified:
            names = ", ".join(assets[item_id].name for item_id in unverified)
            return .5 if dependency_verified else .35, f"critical readiness remains unverified for {names}", actions
        if not dependency_verified:
            return .6, "one or more material dependency records remain unverified", actions
        return 1.0, "material asset state and dependency paths are verified", actions

    @staticmethod
    def _source_agreement(asset: Asset, graph: DependencyGraph, consequence: ConsequenceAssessment) -> tuple[float, str]:
        identity_score = 1.0 if len(asset.source_ids) >= 2 else .6
        path_nodes = {asset.sgw_id, *(path.service_asset_id for path in consequence.paths), *(path.zone_id for path in consequence.paths)}
        relevant = [edge for edge in graph.dependencies if edge.from_id in path_nodes or edge.to_id in path_nodes]
        dependency_score = sum(edge.confidence for edge in relevant) / len(relevant) if relevant else 1.0
        score = min(identity_score, dependency_score)
        return score, f"canonical identity and {len(relevant)} relevant dependency record(s) are consistent"
