from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets = adapter.load_assets()
advisories = adapter.load_advisories()
states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
timeline = AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))

for advisory_id in ["ADV-T24", "ADV-T12"]:
    s17 = next(item for item in timeline[advisory_id] if item.sgw_id == "SGW-S17")
    print(f"{advisory_id}: S17 risk={s17.risk_score:.1f} {s17.tier.value}; confidence={s17.confidence} ({s17.confidence_score:.1f})")
    for reason in s17.confidence_reasons:
        print(f"  - {reason}")
    for action in s17.verification_actions:
        print(f"  action: {action}")
