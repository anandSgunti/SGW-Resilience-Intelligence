from __future__ import annotations

from collections import defaultdict, deque

from sgw_platform.models import Dependency, RelationshipType


class DependencyGraph:
    def __init__(self, dependencies: list[Dependency]):
        self.dependencies = dependencies
        self.outbound: dict[str, list[Dependency]] = defaultdict(list)
        self.inbound: dict[str, list[Dependency]] = defaultdict(list)
        for edge in dependencies:
            self.outbound[edge.from_id].append(edge)
            self.inbound[edge.to_id].append(edge)

    def descendants(self, root_id: str) -> set[str]:
        visited: set[str] = set()
        queue = deque([root_id])
        while queue:
            node = queue.popleft()
            for edge in self.outbound[node]:
                if edge.to_id not in visited:
                    visited.add(edge.to_id)
                    queue.append(edge.to_id)
        return visited

    def ancestors(self, node_id: str) -> set[str]:
        """Every asset whose service path runs through `node_id`."""
        visited: set[str] = set()
        queue = deque([node_id])
        while queue:
            node = queue.popleft()
            for edge in self.inbound[node]:
                if edge.from_id not in visited:
                    visited.add(edge.from_id)
                    queue.append(edge.from_id)
        return visited

    def related(self, node_id: str) -> set[str]:
        """Assets with a real topological relationship to `node_id`.

        Used to separate genuine cascade effects from assets that merely
        changed rank because the ordering was recomputed.
        """
        return (self.ancestors(node_id) | self.descendants(node_id)) - {node_id}

    def has_alternate_power(self, asset_id: str, failed_source_id: str) -> bool:
        """True when another power edge reaches an asset in the same feed group."""
        power_edges = [e for e in self.inbound[asset_id] if e.relationship in {RelationshipType.POWERS, RelationshipType.BACKUP_FEED}]
        return any(edge.from_id != failed_source_id for edge in power_edges)

    def has_full_alternate_power(self, asset_id: str, failed_source_id: str) -> bool:
        """An alternate feed only removes most impact when it can carry the load."""
        power_edges = [e for e in self.inbound[asset_id] if e.relationship in {RelationshipType.POWERS, RelationshipType.BACKUP_FEED}]
        return any(
            edge.from_id != failed_source_id
            and (edge.capacity_share if edge.capacity_share is not None else (1.0 if edge.relationship == RelationshipType.POWERS else 0.0)) >= .8
            for edge in power_edges
        )
