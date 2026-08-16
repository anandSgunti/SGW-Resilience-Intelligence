from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets = adapter.load_assets()
advisories = adapter.load_advisories()
states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
timeline = AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))

for advisory_id, asset_id in [("ADV-T24", "SGW-S17"), ("ADV-T12", "SGW-P11"), ("ADV-T12", "SGW-S17")]:
    assessment = next(item for item in timeline[advisory_id] if item.sgw_id == asset_id)
    print(f"{advisory_id} {asset_id}: {assessment.primary_change}")
    for change in assessment.change_drivers:
        print(f"  {change.metric}: {change.previous} -> {change.current} ({change.impact})")
