from __future__ import annotations

import json
from pathlib import Path

from sgw_platform.adapters.base import InfrastructureAdapter
from sgw_platform.models import Advisory, Asset, AssetState, AssetType, Dependency, RelationshipType


class JsonInfrastructureAdapter(InfrastructureAdapter):
    def __init__(self, path: str | Path):
        self.payload = json.loads(Path(path).read_text(encoding="utf-8"))

    def load_assets(self) -> list[Asset]:
        return [Asset(asset_type=AssetType(row["asset_type"]), **{k: v for k, v in row.items() if k != "asset_type"}) for row in self.payload["assets"]]

    def load_dependencies(self) -> list[Dependency]:
        return [Dependency(relationship=RelationshipType(row["relationship"]), **{k: v for k, v in row.items() if k != "relationship"}) for row in self.payload["dependencies"]]

    def load_advisories(self) -> list[Advisory]:
        return [Advisory(
            changes=tuple(row.get("changes", [])),
            storm_track=tuple(row.get("storm_track", [])),
            **{k: v for k, v in row.items() if k not in {"changes", "storm_track"}},
        ) for row in self.payload["advisories"]]

    def load_states(self, advisory_id: str) -> list[AssetState]:
        return [AssetState(**row) for row in self.payload["states"] if row["advisory_id"] == advisory_id]
