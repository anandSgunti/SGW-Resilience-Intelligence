from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import RecommendationStatus
from sgw_platform.playbooks import PlaybookEngine, RecommendationStore


adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
asset_list = adapter.load_assets()
assets = {asset.sgw_id: asset for asset in asset_list}
advisories = adapter.load_advisories()
advisory_map = {advisory.advisory_id: advisory for advisory in advisories}
states = {
    advisory.advisory_id: adapter.load_states(advisory.advisory_id)
    for advisory in advisories
}
timeline = AssessmentEngine().assess_timeline(
    asset_list,
    advisories,
    states,
    DependencyGraph(adapter.load_dependencies()),
)
engine = PlaybookEngine()

for advisory_id in ("ADV-T24", "ADV-T12"):
    recommendations = engine.evaluate(
        timeline[advisory_id], assets, advisory_map[advisory_id]
    )
    print(f"\n{advisory_id} recommendations")
    for item in recommendations:
        target = f" -> {item.target_asset_id}" if item.target_asset_id else ""
        print(
            f"{item.rule_id} {item.asset_id}{target}: "
            f"{item.priority.value.upper()} | {item.title}"
        )

sample = next(
    item for item in engine.evaluate(
        timeline["ADV-T24"], assets, advisory_map["ADV-T24"]
    )
    if item.rule_id == "R1" and item.asset_id == "SGW-S17"
)
store = RecommendationStore()
store.add(sample)
store.transition(sample.recommendation_id, RecommendationStatus.APPROVED, "Demo Controller")
assigned = store.transition(
    sample.recommendation_id,
    RecommendationStatus.ASSIGNED,
    "Demo Controller",
    owner=sample.default_owner,
)
print(
    f"\nHuman decision example: {assigned.recommendation_id} is "
    f"{assigned.status.value} to {assigned.owner}; audit events={len(assigned.history)}"
)
