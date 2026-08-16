"""Cross-boundary contract tests.

The frontend suite asserts on rendered HTML and on source strings. Neither can
catch a frontend value that the backend does not accept, because server-side
rendering never runs the client effects that issue the requests. This module
closes that gap: it reads the literals the client is hard-coded to send and
proves the running API accepts them.

The 6D.4 trajectory shipped broken because `T-0` was sent where the backend
publishes `Landfall`; every check here exists to make that class of bug fail
in CI rather than in the browser.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.api import create_app
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import TemplateNarrator


FRONTEND = Path(__file__).parents[1] / "frontend" / "app"
SCREENS = {
    "overview": FRONTEND / "page.tsx",
    "asset_risk": FRONTEND / "asset-risk" / "page.tsx",
    "respond": FRONTEND / "respond" / "page.tsx",
    "leadership": FRONTEND / "leadership" / "page.tsx",
    "shared_context": FRONTEND / "IncidentContext.tsx",
}

pytestmark = pytest.mark.skipif(
    not SCREENS["overview"].exists(),
    reason="frontend sources are not present in this checkout",
)


@pytest.fixture(scope="module")
def client() -> TestClient:
    data_path = Path(__file__).parents[1] / "data" / "synthetic_sgw.json"
    platform = PlatformApplication(JsonInfrastructureAdapter(data_path), narrator=TemplateNarrator())
    return TestClient(create_app(platform))


def _source(name: str) -> str:
    return SCREENS[name].read_text(encoding="utf-8")


def _array_literal(source: str, name: str) -> list[str]:
    """Collect the string literals of a top-level `const <name> = [...]`."""
    match = re.search(rf"const {name}(?::[^=]+)? = \[(.*?)\][^;]*;", source, re.S)
    assert match, f"could not locate the {name} literal"
    return re.findall(r'"([^"]+)"', match.group(1))


def test_leadership_trajectory_stages_all_resolve(client):
    """Every tile in the 6D.4 strip must map to a real advisory."""
    stages = _array_literal(_source("leadership"), "STAGES")
    assert stages, "leadership STAGES literal is empty"
    unresolved = [item for item in stages if client.get("/api/state", params={"t": item}).status_code != 200]
    assert not unresolved, f"leadership sends advisory tokens the backend rejects: {unresolved}"


def test_overview_timeline_stages_all_resolve(client):
    """The Screen 1 advisory timeline sends `value`, not the display `label`."""
    values = re.findall(r'value:\s*"([^"]+)"\s*}', _source("overview"))
    stages = [item for item in values if item.startswith("T-") or item == "Landfall"]
    assert stages, "could not locate the overview TIMELINE values"
    unresolved = [item for item in stages if client.get("/api/state", params={"t": item}).status_code != 200]
    assert not unresolved, f"overview sends advisory tokens the backend rejects: {unresolved}"


def test_every_client_stage_token_matches_a_published_stage(client):
    """No screen may hard-code an advisory label the API does not publish."""
    published = {client.get("/api/state").json()["advisory"]["stage"]}
    for stage in ["T-72", "T-48", "T-24", "T-12", "Landfall"]:
        published.add(client.get("/api/state", params={"t": stage}).json()["advisory"]["stage"])

    quoted = set()
    for name in SCREENS:
        # Advisory-shaped literals only: T-<digits>, or a bare Landfall token.
        quoted.update(re.findall(r'"(T-\d+|Landfall)"', _source(name)))
    unknown = sorted(quoted - published)
    assert not unknown, f"screens reference advisory stages the backend does not publish: {unknown}"


def test_client_api_paths_exist_on_the_backend(client):
    """Every literal `/api/...` path a screen fetches must be a real route."""
    routes = {
        route.replace("{asset_id}", "*").replace("{recommendation_id}", "*").replace("{briefing_id}", "*")
        for route in client.app.openapi()["paths"]
    }
    referenced: set[str] = set()
    for name in SCREENS:
        for path in re.findall(r"`\$\{API(?:_URL)?\}(/api/[^`?]*)", _source(name)):
            # Collapse interpolated identifiers to the wildcard used above.
            referenced.add(re.sub(r"\$\{[^}]+\}", "*", path).rstrip("/"))
    missing = sorted(item for item in referenced if item not in routes)
    assert not missing, f"screens fetch paths that the API does not expose: {missing}"


def test_response_action_verbs_are_accepted_by_the_lifecycle(client):
    """The Respond board's action strings must match the backend action map."""
    verbs = set(re.findall(r'Decision = ((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+")', _source("respond")))
    assert verbs, "could not locate the Decision union in the respond screen"
    declared = set(re.findall(r'"([a-z_]+)"', verbs.pop()))
    supported = {"approve", "reject", "assign", "start", "complete"}
    assert declared <= supported, f"respond offers actions the backend rejects: {sorted(declared - supported)}"
