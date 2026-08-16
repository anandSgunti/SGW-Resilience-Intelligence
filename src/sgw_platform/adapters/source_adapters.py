"""Source-specific readers that normalise fragmented operational identifiers."""
from __future__ import annotations

from typing import Any

from sgw_platform.adapters.base import normalize_source_id


class SourceRecordIndex:
    """Maps each raw-source identifier to one canonical SGW identity."""
    def __init__(self, source_data: dict[str, list[dict[str, Any]]]):
        self._canonical_by_source_id: dict[str, str] = {}
        for provider, records in source_data.items():
            for record in records:
                canonical_id = record["canonical_sgw_id"]
                self._canonical_by_source_id[normalize_source_id(provider, record["source_id"])] = canonical_id

    def resolve(self, provider: str, source_id: str) -> str:
        return self._canonical_by_source_id[normalize_source_id(provider, source_id)]
