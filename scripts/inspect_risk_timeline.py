from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets = adapter.load_assets()
advisories = adapter.load_advisories()
states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
timeline = AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))

for advisory in advisories:
    results = {item.sgw_id: item for item in timeline[advisory.advisory_id]}
    s17, s31 = results["SGW-S17"], results["SGW-S31"]
    print(
        f"{advisory.advisory_id:8} "
        f"S17 #{s17.rank:02} {s17.tier.value:8} risk={s17.risk_score:4.1f} move={s17.rank_change!s:>3} | "
        f"S31 #{s31.rank:02} {s31.tier.value:8} risk={s31.risk_score:4.1f} move={s31.rank_change!s:>3}"
    )
