"""Reviewer-facing, network-free acceptance gate for Clone → Run → Demo."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.api import create_app
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import ExplanationError, TemplateNarrator


def assessment(state: dict, asset_id: str) -> dict:
    return next(item for item in state["assessments"] if item["sgw_id"] == asset_id)


def check(label: str, condition: bool, detail: str) -> None:
    if not condition:
        raise AssertionError(f"{label}: {detail}")
    print(f"[PASS] {label}\n       {detail}")


def main() -> None:
    data_path = ROOT / "data" / "synthetic_sgw.json"
    platform = PlatformApplication(JsonInfrastructureAdapter(data_path), narrator=TemplateNarrator())
    t48 = platform.current_state("T-48")
    t24 = platform.current_state("T-24")
    s17_t48, s17_t24 = assessment(t48, "SGW-S17"), assessment(t24, "SGW-S17")

    check("Included seed-42 data loads", data_path.is_file(), str(data_path.relative_to(ROOT)))
    check("Hurricane Iris is the default event", t24["advisory"]["event_id"] == "HURRICANE-IRIS", "HURRICANE-IRIS at T-24")
    check("T-48 and T-24 are immediately available", t48["advisory"]["stage"] == "T-48" and t24["advisory"]["stage"] == "T-24", "both advisory snapshots loaded")
    check("S17 transition is reproducible", (s17_t48["tier"], s17_t48["rank"], s17_t48["restoration_hours"], s17_t48["max_uncovered_hours"]) == ("high", 5, 4, 0) and (s17_t24["tier"], s17_t24["rank"], s17_t24["restoration_hours"], s17_t24["max_uncovered_hours"]) == ("critical", 1, 14, 8), "High #5, 4h/0h -> Critical #1, 14h/8h")

    routes = {route.path for route in create_app(platform).routes}
    required_api = {"/api/state", "/api/assets/{asset_id}", "/api/explain", "/api/responses/{recommendation_id}", "/api/briefings"}
    check("Core API contracts are exposed", required_api <= routes, f"{len(routes)} total routes")
    screens = [ROOT / "frontend" / "app" / "page.tsx", ROOT / "frontend" / "app" / "asset-risk" / "page.tsx", ROOT / "frontend" / "app" / "respond" / "page.tsx", ROOT / "frontend" / "app" / "leadership" / "page.tsx"]
    check("All four screens are present", all(item.is_file() for item in screens), "Risk Overview, Asset Risk, Response, Leadership")

    explanation = platform.explain("Why is S17 above S31?", "T-24", "SGW-S17")
    check("OpenAI is optional", explanation["grounded"] and explanation["model"] == "deterministic-template", "offline grounded narrator active")

    class FailingNarrator:
        model = "unavailable-openai"
        def generate(self, _fact_pack):
            raise ExplanationError("OpenAI unavailable")

    degraded = PlatformApplication(JsonInfrastructureAdapter(data_path), narrator=FailingNarrator())
    degraded_state = degraded.current_state("T-24")
    check("LLM failure leaves Assess -> Respond available", bool(degraded_state["assessments"] and degraded_state["responses"]), "rankings and recommendations remain available")

    portable_files = [*ROOT.glob("*.toml"), *ROOT.glob("*.md"), *ROOT.glob("*.example"), *ROOT.glob("scripts/*.py"), *ROOT.glob("src/**/*.py"), *ROOT.glob("frontend/app/**/*.tsx")]
    combined = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in portable_files)
    check("No local absolute paths", "C:\\Users\\" not in combined, "portable source/configuration scan clean")
    check("No committed OpenAI-style secret", re.search(r"sk-(?:proj|svcacct)-[A-Za-z0-9_-]{10,}", combined) is None, "secret-pattern scan clean")
    check("Environment and dependency contracts exist", (ROOT / ".env.example").is_file() and (ROOT / "frontend" / "package-lock.json").is_file() and "==" in (ROOT / "pyproject.toml").read_text(encoding="utf-8"), ".env.example, Python pins and npm lock present")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    commands = ["python -m pip install", "npm --prefix frontend ci", "python scripts/run_api.py", "npm --prefix frontend run dev"]
    check("README contains the complete clean-run path", all(command in readme for command in commands), "configure and two-terminal launch documented")
    print("\nClean-run acceptance: READY")


if __name__ == "__main__":
    main()
