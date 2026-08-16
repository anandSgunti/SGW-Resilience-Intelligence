from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets, graph = adapter.load_assets(), DependencyGraph(adapter.load_dependencies())
for advisory in adapter.load_advisories():
    assessed = {item.sgw_id: item for item in AssessmentEngine().assess(assets, adapter.load_states(advisory.advisory_id), advisory, graph)}
    states = {item.sgw_id: item for item in adapter.load_states(advisory.advisory_id)}
    print(f"{advisory.advisory_id:8} S17 {assessed['SGW-S17'].tier.value:8} ({assessed['SGW-S17'].risk_score:4.1f}) | restoration {states['SGW-S17'].restoration_hours:4.1f}h | P11 flood {states['SGW-P11'].flood_depth_m:.2f}m | P4 {states['SGW-P4'].verification_status}")
