from types import SimpleNamespace

from fastapi.testclient import TestClient

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.api import create_app
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import ExplanationError, OpenAIResponsesNarrator
from sgw_platform.synthetic import write_synthetic_data


class _Responses:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output_text="S17 is above S31 because its supplied systemic consequence is higher; confidence remains evidence-bound.")


def _client(tmp_path):
    responses = _Responses()
    narrator = OpenAIResponsesNarrator(model="gpt-5.6-luna", client=SimpleNamespace(responses=responses))
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "golden-network.json", seed=42))
    platform = PlatformApplication(adapter, narrator=narrator)
    return TestClient(create_app(platform)), responses


def _assessment(payload, asset_id):
    return next(item for item in payload["assessments"] if item["sgw_id"] == asset_id)


def test_golden_path_operational_evidence_drives_assess_respond_inform(tmp_path):
    client, responses_api = _client(tmp_path)

    # 1. T-48 starts with a real evidence-derived rank, not a UI-authored jump.
    t48 = client.get("/api/state", params={"t": "T-48"}).json()
    s17_t48 = _assessment(t48, "SGW-S17")
    detail_t48 = client.get("/api/assets/SGW-S17", params={"t": "T-48"}).json()
    assert (s17_t48["tier"], s17_t48["rank"]) == ("high", 5)
    assert s17_t48["restoration_hours"] == 4
    assert s17_t48["max_uncovered_hours"] == 0
    assert detail_t48["node_context"]["SGW-P4"]["state"]["backup_available_hours"] == 6

    # 2. The T-24 backend assessment exposes every material transition.
    t24 = client.get("/api/state", params={"t": "T-24"}).json()
    s17_t24 = _assessment(t24, "SGW-S17")
    changes = {item["metric"]: item for item in s17_t24["change_drivers"]}
    assert (s17_t24["tier"], s17_t24["rank"]) == ("critical", 1)
    assert (s17_t24["restoration_hours"], s17_t24["max_uncovered_hours"]) == (14, 8)
    assert (changes["restoration_hours"]["previous"], changes["restoration_hours"]["current"]) == (4, 14)
    assert (changes["rank"]["previous"], changes["rank"]["current"]) == (5, 1)

    # 3. Asset Risk uses the same state, graph and bounded OpenAI fact pack.
    detail = client.get("/api/assets/SGW-S17", params={"t": "T-24"}).json()
    edges = {(item["from_id"], item["to_id"]) for item in detail["dependency_subgraph"]["edges"]}
    assert {("SGW-S17", "SGW-P4"), ("SGW-P4", "SGW-W12"), ("SGW-W12", "SGW-H3"), ("SGW-W12", "SGW-F2")} <= edges
    assert detail["assessment"]["confidence"] == "medium"
    explanation = client.post("/api/explain", json={"question": "Why is S17 above S31?", "asset_id": "SGW-S17", "advisory": "T-24"}).json()
    assert explanation["grounded"] is True and explanation["model"] == "gpt-5.6-luna"
    assert "S31" in explanation["answer"] and len(explanation["fact_pack_sha256"]) == 64
    assert responses_api.calls[-1]["store"] is False

    # 4–5. A deterministic verification action remains human-controlled.
    action = next(item for item in t24["responses"] if item["action_class"] == "field_verification" and item["target_asset_id"] == "SGW-P4")
    for operation, body in [
        ("approve", {"actor": "Nova Reed", "occurred_at": "2026-09-03T12:00:00+00:00"}),
        ("assign", {"actor": "Nova Reed", "owner": "Field Operations", "occurred_at": "2026-09-03T12:05:00+00:00"}),
        ("start", {"actor": "Avery Chen", "occurred_at": "2026-09-03T12:30:00+00:00"}),
    ]:
        result = client.post(f"/api/responses/{action['recommendation_id']}", json={"action": operation, **body})
        assert result.status_code == 200, result.text
    completed = client.post(f"/api/responses/{action['recommendation_id']}", json={
        "action": "complete", "actor": "Avery Chen", "reason": "Generator operational; six-hour load test confirmed.", "occurred_at": "2026-09-03T13:42:00+00:00",
        "result": {"outcome": "verified_operational", "detail": "Generator operational", "verified_by": "Field Operations", "confirmed_backup_hours": 6},
    })
    assert completed.status_code == 200, completed.text
    record = completed.json()
    assert [item["status"] for item in record["history"]] == ["approved", "assigned", "in_progress", "completed"]
    assert all(item["actor"] for item in record["history"])
    assert all(item["occurred_at"] for item in record["history"])

    refreshed = client.get("/api/state", params={"t": "T-24"}).json()
    refreshed_s17 = _assessment(refreshed, "SGW-S17")
    assert refreshed_s17["confidence"] == "high"
    assert refreshed_s17["tier"] == "critical"
    assert refreshed_s17["risk_score"] == s17_t24["risk_score"]
    assert refreshed["summary"]["open_actions"] < t24["summary"]["open_actions"]
    assert len(refreshed["verifications"]) == 1

    # 6. Leadership reads that same refreshed state; brief publication is attributed.
    draft = client.post("/api/briefings", json={"advisory": "T-24"}).json()
    assert draft["status"] == "draft" and draft["advisory_id"] == refreshed["advisory"]["advisory_id"]
    approved = client.post(f"/api/briefings/{draft['briefing_id']}/approve", json={"approved_by": "Nova Reed", "approved_at": "2026-09-03T14:00:00+00:00", "final_text": draft["text"]}).json()
    assert (approved["status"], approved["approved_by"], approved["version"]) == ("approved", "Nova Reed", 1)
    assert approved["fact_pack_sha256"] == draft["fact_pack_sha256"]


def test_llm_failure_does_not_break_assess_or_respond(tmp_path):
    class FailingNarrator:
        model = "unavailable-openai"
        def generate(self, _fact_pack):
            raise ExplanationError("OpenAI unavailable")

    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "fallback-network.json", seed=42))
    client = TestClient(create_app(PlatformApplication(adapter, narrator=FailingNarrator())), raise_server_exceptions=False)
    assert client.post("/api/explain", json={"question": "Why?", "asset_id": "SGW-S17", "advisory": "T-24"}).status_code == 500
    state = client.get("/api/state", params={"t": "T-24"})
    detail = client.get("/api/assets/SGW-S17", params={"t": "T-24"})
    assert state.status_code == 200 and detail.status_code == 200
    assert state.json()["assessments"][0]["sgw_id"] == "SGW-S17"
    assert detail.json()["recommended_actions"]
