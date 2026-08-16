import argparse
from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph

parser = argparse.ArgumentParser()
parser.add_argument("--advisory", default="ADV-T24")
args = parser.parse_args()
adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
advisory = next(a for a in adapter.load_advisories() if a.advisory_id == args.advisory)
results = AssessmentEngine().assess(adapter.load_assets(), adapter.load_states(args.advisory), advisory, DependencyGraph(adapter.load_dependencies()))
for result in results[:10]:
    print(f"{result.sgw_id:9} {result.tier.value:9} risk={result.risk_score:5.1f} likelihood={result.disruption_likelihood:4.1f}% consequence={result.consequence_score:4.1f}")
