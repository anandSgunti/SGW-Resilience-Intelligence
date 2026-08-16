from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from sgw_platform.models import Advisory, Asset, AssetState, Dependency


class InfrastructureAdapter(ABC):
    """Boundary for synthetic, public, or production source systems."""

    @abstractmethod
    def load_assets(self) -> list[Asset]: ...

    @abstractmethod
    def load_dependencies(self) -> list[Dependency]: ...

    @abstractmethod
    def load_advisories(self) -> list[Advisory]: ...

    @abstractmethod
    def load_states(self, advisory_id: str) -> list[AssetState]: ...


def normalize_source_id(provider: str, source_id: str) -> str:
    """Stable lookup key for fragmented upstream identifiers."""
    return f"{provider.strip().lower()}:{source_id.strip().upper()}"

