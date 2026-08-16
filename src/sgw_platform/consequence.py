from __future__ import annotations

from sgw_platform.graph import DependencyGraph
from sgw_platform.models import (
    Advisory,
    Asset,
    AssetState,
    AssetType,
    ConsequenceAssessment,
    ConsequencePath,
    RelationshipType,
)


CRITICAL_TYPES = {
    AssetType.HOSPITAL,
    AssetType.FIRE_STATION,
    AssetType.EMERGENCY_OPERATIONS_CENTRE,
    AssetType.DIALYSIS_CENTRE,
    AssetType.POLICE_STATION,
}


class ConsequenceEngine:
    """Derives service consequence from topology, duration, and resilience."""

    BASE_CONSEQUENCE = {
        AssetType.SUBSTATION: 26.2,
        AssetType.PUMP_STATION: 20.0,
        AssetType.WATER_ZONE: 18.0,
        AssetType.HOSPITAL: 30.0,
        AssetType.FIRE_STATION: 26.0,
        AssetType.EMERGENCY_OPERATIONS_CENTRE: 30.0,
        AssetType.DIALYSIS_CENTRE: 28.0,
        AssetType.POLICE_STATION: 26.0,
    }

    def assess(
        self,
        asset: Asset,
        assets: dict[str, Asset],
        states: dict[str, AssetState],
        advisory: Advisory,
        graph: DependencyGraph,
    ) -> ConsequenceAssessment:
        base = self.BASE_CONSEQUENCE[asset.asset_type] + 16.0 * float(asset.attributes.get("intrinsic_criticality", 0.0))
        paths = tuple(self._service_paths(asset, assets, states, graph))
        raw_score = round(base + sum(path.adjusted_impact for path in paths), 1)
        score = min(96.0, raw_score)
        facilities = tuple(sorted({facility for path in paths for facility in path.critical_facilities}))
        facility_ids = tuple(sorted({item for path in paths for item in path.critical_facility_ids}))
        zone_ids = tuple(sorted({path.zone_id for path in paths}))
        affected_population = sum(path.population for path in paths)
        effective_population = sum(path.effective_population for path in paths)
        max_uncovered = max((path.uncovered_hours for path in paths), default=0.0)
        drivers = self._drivers(paths, base)
        return ConsequenceAssessment(
            advisory.advisory_id,
            asset.sgw_id,
            score,
            raw_score,
            base,
            affected_population,
            effective_population,
            facilities,
            max_uncovered,
            paths,
            drivers,
            facility_ids,
            zone_ids,
        )

    def _service_paths(
        self,
        asset: Asset,
        assets: dict[str, Asset],
        states: dict[str, AssetState],
        graph: DependencyGraph,
    ):
        service_assets: list[tuple[str, float]] = []
        if asset.asset_type == AssetType.SUBSTATION:
            for edge in graph.outbound[asset.sgw_id]:
                if edge.relationship in {RelationshipType.POWERS, RelationshipType.BACKUP_FEED}:
                    service_assets.append((edge.to_id, self._resilience_factor(edge.to_id, asset.sgw_id, graph)))
        elif asset.asset_type == AssetType.PUMP_STATION:
            service_assets.append((asset.sgw_id, 1.0))
        elif asset.asset_type == AssetType.WATER_ZONE:
            service_assets.append((asset.sgw_id, 1.0))

        for service_id, resilience in service_assets:
            zone_edges = []
            if assets[service_id].asset_type == AssetType.WATER_ZONE:
                zone_edges = [(service_id, 1.0)]
            else:
                zone_edges = [
                    (edge.to_id, edge.capacity_share if edge.capacity_share is not None else 1.0)
                    for edge in graph.outbound[service_id]
                    if edge.relationship == RelationshipType.SERVES
                ]
            for zone_id, capacity_lost in zone_edges:
                zone = assets[zone_id]
                population = int(zone.attributes.get("population", 0))
                effective_population = round(population * capacity_lost)
                facility_ids = tuple(sorted(
                    edge.to_id
                    for edge in graph.outbound[zone_id]
                    if edge.to_id in assets and assets[edge.to_id].asset_type in CRITICAL_TYPES
                ))
                facility_names = tuple(sorted(assets[item_id].name for item_id in facility_ids))
                restoration = states[asset.sgw_id].restoration_hours
                backup = self._backup_hours(service_id, assets, states)
                uncovered = round(max(restoration - backup, 0.0), 1)
                severity, duration_factor = self._duration(uncovered)
                population_points = min(50.0, effective_population / 58_800 * 50)
                facility_points = min(24.0, len(facility_names) * 12.0)
                exposure = round(population_points + facility_points, 1)
                adjusted = round(exposure * duration_factor * resilience, 1)
                yield ConsequencePath(
                    asset.sgw_id,
                    service_id,
                    zone_id,
                    population,
                    effective_population,
                    facility_names,
                    facility_ids,
                    restoration,
                    backup,
                    uncovered,
                    severity,
                    duration_factor,
                    resilience,
                    capacity_lost,
                    exposure,
                    adjusted,
                )

    @staticmethod
    def _backup_hours(service_id: str, assets: dict[str, Asset], states: dict[str, AssetState]) -> float:
        state = states[service_id]
        if state.backup_available_hours is not None:
            return float(state.backup_available_hours)
        return float(assets[service_id].attributes.get("backup_endurance_hours", 0))

    @staticmethod
    def _duration(uncovered: float) -> tuple[str, float]:
        if uncovered <= 0:
            return "minimal", 0.5
        if uncovered <= 3:
            return "low", 0.8
        if uncovered <= 6:
            return "moderate", 0.9
        if uncovered <= 12:
            return "high", 1.0
        return "very_high", 1.1

    @staticmethod
    def _resilience_factor(service_id: str, failed_source_id: str, graph: DependencyGraph) -> float:
        alternate_capacity = sum(
            edge.capacity_share if edge.capacity_share is not None else (1.0 if edge.relationship == RelationshipType.POWERS else 0.0)
            for edge in graph.inbound[service_id]
            if edge.from_id != failed_source_id
            and edge.relationship in {RelationshipType.POWERS, RelationshipType.BACKUP_FEED}
        )
        if alternate_capacity >= 0.8:
            return 0.4
        if alternate_capacity > 0:
            return 0.7
        return 1.0

    @staticmethod
    def _drivers(paths: tuple[ConsequencePath, ...], base: float) -> tuple[str, ...]:
        if not paths:
            return (f"base asset consequence is {base:.0f}", "no material downstream service dependency is modeled")
        effective = sum(path.effective_population for path in paths)
        facilities = sorted({facility for path in paths for facility in path.critical_facilities})
        max_uncovered = max(path.uncovered_hours for path in paths)
        strongest_resilience = min(path.resilience_factor for path in paths)
        return (
            f"{effective:,} effective residents exposed",
            f"{len(facilities)} critical facilit{'y' if len(facilities) == 1 else 'ies'} downstream",
            f"maximum uncovered service duration is {max_uncovered:.1f}h",
            f"resilience adjustment factor is {strongest_resilience:.1f}",
        )
