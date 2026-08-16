from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.consequence import ConsequenceEngine
from sgw_platform.graph import DependencyGraph

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets = {asset.sgw_id: asset for asset in adapter.load_assets()}
advisory = next(item for item in adapter.load_advisories() if item.advisory_id == "ADV-T24")
states = {state.sgw_id: state for state in adapter.load_states(advisory.advisory_id)}
graph = DependencyGraph(adapter.load_dependencies())
engine = ConsequenceEngine()

for asset_id in ["SGW-S17", "SGW-S31", "SGW-S08", "SGW-P11", "SGW-S01"]:
    result = engine.assess(assets[asset_id], assets, states, advisory, graph)
    print(
        f"{asset_id:9} consequence={result.score:4.1f} "
        f"effective_population={result.effective_population:6,d} "
        f"facilities={len(result.critical_facilities)} "
        f"uncovered={result.max_uncovered_hours:4.1f}h"
    )
