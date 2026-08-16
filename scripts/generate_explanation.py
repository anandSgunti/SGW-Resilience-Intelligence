import argparse
import os
from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.explanations import ExplanationService, OpenAIResponsesNarrator, TemplateNarrator
from sgw_platform.graph import DependencyGraph

parser = argparse.ArgumentParser()
parser.add_argument("--asset", default="SGW-S17")
parser.add_argument("--advisory", default="ADV-T24")
parser.add_argument("--offline", action="store_true", help="Use the deterministic template instead of the OpenAI API")
args = parser.parse_args()

adapter = JsonInfrastructureAdapter(Path(__file__).parents[1] / "data" / "synthetic_sgw.json")
assets = adapter.load_assets()
assets_by_id = {asset.sgw_id: asset for asset in assets}
advisories = adapter.load_advisories()
advisories_by_id = {advisory.advisory_id: advisory for advisory in advisories}
states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
timeline = AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))
assessment = next(item for item in timeline[args.advisory] if item.sgw_id == args.asset)

if not args.offline and not os.getenv("OPENAI_API_KEY"):
    raise SystemExit("OPENAI_API_KEY is not configured. Set it in the environment or use --offline.")
narrator = TemplateNarrator() if args.offline else OpenAIResponsesNarrator()
result = ExplanationService(narrator).explain(assets_by_id[args.asset], advisories_by_id[args.advisory], assessment)
print(result.text)
print(f"model={result.model} fact_pack_sha256={result.fact_pack_sha256}")
