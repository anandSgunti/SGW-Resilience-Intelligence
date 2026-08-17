import pytest
from fastapi.testclient import TestClient

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.api import create_app
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import TemplateNarrator
from sgw_platform.synthetic import write_synthetic_data


@pytest.fixture
def client(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    platform = PlatformApplication(adapter, narrator=TemplateNarrator())
    return TestClient(create_app(platform))


def test_current_state_is_one_ranked_backend_contract(client):
    response = client.get("/api/state", params={"t": "T-24"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["advisory"]["advisory_id"] == "ADV-T24"
    assert payload["assessments"][0]["sgw_id"] == "SGW-S17"
    assert payload["assessments"][0]["rank"] == 1
    assert payload["assessments"][0]["tier"] == "critical"
    assert len(payload["map"]["assets"]) == 40
    assert payload["map"]["hurricane"]["event_id"] == "HURRICANE-IRIS"
    assert len(payload["map"]["hurricane"]["track"]) == 5
    assert payload["map"]["hurricane"]["impact_radius_km"] > 0
    assert payload["summary"]["critical_assets"] == sum(item["tier"] == "critical" for item in payload["assessments"])
    assert payload["summary"]["high_assets"] == sum(item["tier"] == "high" for item in payload["assessments"])
    assert payload["summary"]["exposed_residents"] > 0
    assert payload["summary"]["open_actions"] == len(payload["responses"])
    assert "data_freshness_minutes" not in payload["summary"]
    assert {item["rule_id"] for item in payload["responses"]} == {"R1", "R2", "R3", "R5"}


def test_asset_detail_contains_dependency_and_decision_context(client):
    response = client.get("/api/assets/SGW-S17", params={"t": "T-24"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["asset"]["sgw_id"] == "SGW-S17"
    edges = {
        (edge["from_id"], edge["to_id"])
        for edge in payload["dependency_subgraph"]["edges"]
    }
    assert ("SGW-S17", "SGW-P4") in edges
    assert ("SGW-P4", "SGW-W12") in edges
    assert ("SGW-W12", "SGW-H3") in edges
    assert ("SGW-W12", "SGW-F2") in edges
    assert payload["assessment"]["max_uncovered_hours"] == 8.0
    assert set(payload["node_context"]) >= {"SGW-S17", "SGW-P4", "SGW-W12", "SGW-H3", "SGW-F2"}
    assert payload["node_context"]["SGW-P4"]["state"]["backup_available_hours"] == 6
    assert payload["node_context"]["SGW-P4"]["assessment"]["confidence"] == "medium"
    f2_edge = next(edge for edge in payload["dependency_subgraph"]["edges"] if edge["to_id"] == "SGW-F2")
    assert f2_edge["verified"] is True
    assert f2_edge["confidence"] < 0.7
    assert len(payload["recommended_actions"]) == 4


def test_fragmented_source_id_resolves_to_canonical_asset(client):
    response = client.get("/api/assets/SU-1000", params={"t": "T-24"})
    assert response.status_code == 200
    assert response.json()["asset"]["sgw_id"] == "SGW-S17"


def test_grounded_explain_contract_supports_asset_and_platform_questions(client):
    asset_response = client.post(
        "/api/explain",
        json={
            "question": "Why is this asset Critical?",
            "asset_id": "SGW-S17",
            "advisory": "T-24",
        },
    )
    assert asset_response.status_code == 200
    asset_payload = asset_response.json()
    assert asset_payload["grounded"] is True
    assert asset_payload["model"] == "deterministic-template"
    assert "68.4" in asset_payload["answer"]
    assert len(asset_payload["fact_pack_sha256"]) == 64
    assert asset_payload["supporting_facts"]

    comparison_response = client.post(
        "/api/explain",
        json={"question": "Why is S17 above S31?", "asset_id": "SGW-S17", "advisory": "T-24"},
    )
    assert comparison_response.status_code == 200
    assert "SGW-S31" in comparison_response.json()["answer"]

    uncertainty_response = client.post(
        "/api/explain",
        json={"question": "What is uncertain?", "asset_id": "SGW-S17", "advisory": "T-24"},
    )
    assert uncertainty_response.status_code == 200
    assert uncertainty_response.json()["answer"] != asset_payload["answer"]

    platform_response = client.post(
        "/api/explain",
        json={"question": "What is the highest risk asset?", "advisory": "T-24"},
    )
    assert platform_response.status_code == 200
    assert "SGW-S17" in platform_response.json()["answer"]


def test_response_decisions_append_human_audit_history(client):
    detail = client.get("/api/assets/SGW-S17", params={"t": "T-24"}).json()
    recommendation_id = next(
        item["recommendation_id"]
        for item in detail["recommended_actions"]
        if item["rule_id"] == "R1"
    )
    decisions = [
        ("approve", {"actor": "Jett Morgan"}),
        ("assign", {"actor": "Jett Morgan", "owner": "Field Operations"}),
        ("start", {"actor": "Taylor Singh"}),
        ("complete", {"actor": "Taylor Singh", "reason": "Generator load-tested."}),
    ]
    response = None
    for action, values in decisions:
        response = client.post(
            f"/api/responses/{recommendation_id}",
            json={"action": action, **values},
        )
        assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["owner"] == "Field Operations"
    assert [item["status"] for item in payload["history"]] == [
        "approved", "assigned", "in_progress", "completed"
    ]
    assert payload["history"][-1]["reason"] == "Generator load-tested."


def test_response_endpoint_enforces_lifecycle(client):
    detail = client.get("/api/assets/SGW-S17", params={"t": "T-24"}).json()
    recommendation_id = detail["recommended_actions"][0]["recommendation_id"]
    response = client.post(
        f"/api/responses/{recommendation_id}",
        json={"action": "complete", "actor": "Jett Morgan"},
    )
    assert response.status_code == 409
    assert "Invalid transition" in response.json()["detail"]


def test_leadership_briefing_keeps_version_and_human_approval(client):
    draft_response = client.post("/api/briefings", json={"advisory": "T-24"})
    assert draft_response.status_code == 200
    draft = draft_response.json()
    assert draft["briefing_id"] == "BRF-ADV-T24-001"
    assert draft["version"] == 1
    assert draft["status"] == "draft"
    assert "SGW-S17" in draft["text"]

    approval_response = client.post(
        f"/api/briefings/{draft['briefing_id']}/approve",
        json={
            "approved_by": "Jett Morgan",
            "approved_at": "2026-08-16T13:00:00+00:00",
            "final_text": "Approved leadership situation summary.",
        },
    )
    assert approval_response.status_code == 200
    approved = approval_response.json()
    assert approved["status"] == "approved"
    assert approved["approved_by"] == "Jett Morgan"
    assert approved["advisory_id"] == "ADV-T24"
    assert approved["version"] == 1
    assert approved["final_text"] == "Approved leadership situation summary."


def test_unknown_advisory_and_asset_return_404(client):
    assert client.get("/api/state", params={"t": "T-99"}).status_code == 404
    assert client.get("/api/assets/SGW-NOT-REAL").status_code == 404


def test_vite_origin_is_allowed_without_opening_cors_to_everywhere(client):
    response = client.options(
        "/api/state",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers.get("access-control-allow-credentials") != "true"

    vinext_response = client.options(
        "/api/state",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert vinext_response.status_code == 200
    assert vinext_response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_data_path_environment_can_swap_the_fixture_without_domain_changes(tmp_path, monkeypatch):
    data_path = write_synthetic_data(tmp_path / "replacement.json")
    monkeypatch.setenv("SGW_DATA_PATH", str(data_path))
    environment_client = TestClient(create_app())
    response = environment_client.get("/api/state", params={"t": "T-24"})
    assert response.status_code == 200
    assert response.json()["assessments"][0]["sgw_id"] == "SGW-S17"


def _verification_action(client):
    payload = client.get("/api/state", params={"t": "T-24"}).json()
    return next(item for item in payload["responses"] if item["action_class"] == "field_verification")


def _advance(client, recommendation_id, steps):
    for action, actor, owner in steps:
        body = {"action": action, "actor": actor}
        if owner:
            body["owner"] = owner
        response = client.post(f"/api/responses/{recommendation_id}", json=body)
        assert response.status_code == 200, response.text


def test_completing_a_verification_action_records_a_field_result(client):
    action = _verification_action(client)
    _advance(client, action["recommendation_id"], [
        ("approve", "Ops Lead", None),
        ("assign", "Ops Lead", "Field Operations"),
        ("start", "Field Technician", None),
    ])
    response = client.post(f"/api/responses/{action['recommendation_id']}", json={
        "action": "complete",
        "actor": "Field Technician",
        "reason": "Site check complete.",
        "occurred_at": "2026-09-03T13:42:00+00:00",
        "result": {
            "outcome": "verified_operational",
            "detail": "Generator operational",
            "verified_by": "Field Operations",
            "confirmed_backup_hours": 6,
        },
    })
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["verification"]["verified_asset_id"] == action["target_asset_id"]
    assert "13:42" in payload["verification"]["narrative"]
    assert payload["verification"]["impacts"]

    refreshed = client.get("/api/state", params={"t": "T-24"}).json()
    source = next(item for item in refreshed["assessments"] if item["sgw_id"] == action["asset_id"])
    assert source["confidence"] == "high"
    assert len(refreshed["verifications"]) == 1
    assert "R2" not in {item["rule_id"] for item in refreshed["responses"] if item["status"] != "completed"}


def test_recording_an_unavailable_backup_reassesses_and_reranks(client):
    action = _verification_action(client)
    before = client.get(f"/api/assets/{action['target_asset_id']}", params={"t": "T-24"}).json()
    _advance(client, action["recommendation_id"], [
        ("approve", "Ops Lead", None),
        ("assign", "Ops Lead", "Field Operations"),
        ("start", "Field Technician", None),
    ])
    response = client.post(f"/api/responses/{action['recommendation_id']}", json={
        "action": "complete", "actor": "Field Technician", "reason": "No usable generator.",
        "result": {"outcome": "unavailable", "detail": "Generator unavailable"},
    })
    assert response.status_code == 200, response.text
    after = client.get(f"/api/assets/{action['target_asset_id']}", params={"t": "T-24"}).json()
    assert after["assessment"]["risk_score"] > before["assessment"]["risk_score"]
    assert after["assessment"]["tier"] == "high" and before["assessment"]["tier"] == "medium"
    assert after["state"]["backup_available_hours"] == 0.0
    assert after["verification_history"]


def test_standalone_verification_endpoint_supports_the_screen_two_handoff(client):
    response = client.post("/api/verifications", json={
        "asset_id": "SGW-P4", "outcome": "verified_operational",
        "verified_by": "Field Operations", "detail": "Generator operational",
        "advisory": "T-24", "confirmed_backup_hours": 6,
    })
    assert response.status_code == 200, response.text
    assert response.json()["applied_to_advisories"] == ["ADV-T24", "ADV-T12", "ADV-T0"]
    listed = client.get("/api/verifications", params={"t": "T-24"})
    assert listed.status_code == 200
    assert len(listed.json()["verifications"]) == 1


def test_invalid_verification_input_returns_the_backend_conflict_message(client):
    unknown_outcome = client.post("/api/verifications", json={
        "asset_id": "SGW-P4", "outcome": "looks_ok", "verified_by": "Field Operations", "advisory": "T-24",
    })
    assert unknown_outcome.status_code == 409
    assert "Unknown field verification outcome" in unknown_outcome.json()["detail"]

    unknown_asset = client.post("/api/verifications", json={
        "asset_id": "SGW-NOPE", "outcome": "verified_operational", "verified_by": "Field Operations",
    })
    assert unknown_asset.status_code == 404

    action = _verification_action(client)
    wrong_step = client.post(f"/api/responses/{action['recommendation_id']}", json={
        "action": "approve", "actor": "Ops Lead",
        "result": {"outcome": "verified_operational", "detail": "too early"},
    })
    assert wrong_step.status_code == 409
    assert "completing the action" in wrong_step.json()["detail"]


def _r1(client):
    payload = client.get("/api/state", params={"t": "T-24"}).json()
    return next(item for item in payload["responses"] if item["rule_id"] == "R1")


def test_state_recommendations_carry_the_three_transparency_layers(client):
    action = _r1(client)
    assert action["rule"]["rule_id"] == "R1"
    assert action["rule"]["version"] == "1.2"
    assert action["rule"]["name"] == "Critical backup-gap response"
    assert action["rule"]["summary"].startswith("Triggered when a Critical asset")
    assert [item["label"] for item in action["rule"]["thresholds"]]
    assert action["evidence"]["trigger"][0]["summary"] == "S17 restoration 14h > P4 backup 6h"
    assert action["evidence"]["impact_summary"] == "8h uncovered \u00b7 W12 \u00b7 F2 \u00b7 H3"
    assert action["evidence"]["assessment_source"] == "IRIS-T24"


def test_playbook_catalogue_publishes_rules_that_did_not_fire(client):
    response = client.get("/api/playbook-rules")
    assert response.status_code == 200
    rules = {item["rule_id"]: item for item in response.json()["rules"]}
    assert set(rules) == {"R1", "R2", "R3", "R4", "R5"}
    assert rules["R4"]["version"] == "1.1"
    # R4 does not fire at T-24 but is still published for transparency.
    fired = {item["rule_id"] for item in client.get("/api/state", params={"t": "T-24"}).json()["responses"]}
    assert "R4" not in fired


def test_governance_record_endpoint_answers_the_audit_questions(client):
    action = _r1(client)
    client.post(f"/api/responses/{action['recommendation_id']}", json={"action": "approve", "actor": "Jett Rowe"})
    response = client.get(f"/api/responses/{action['recommendation_id']}/record")
    assert response.status_code == 200
    record = response.json()
    assert record["what"] == action["title"]
    assert record["why"]["trigger"][0]["summary"] == "S17 restoration 14h > P4 backup 6h"
    assert record["rule_version"] == "1.2"
    assert record["assessment_source"] == "IRIS-T24"
    assert record["advisory_id"] == "ADV-T24"
    assert [item["actor"] for item in record["decisions"]] == ["Jett Rowe"]
    assert client.get("/api/responses/REC-NOPE/record").status_code == 404


def test_rationale_endpoint_is_display_only_and_never_moves_the_action(client):
    action = _r1(client)
    response = client.post(f"/api/responses/{action['recommendation_id']}/rationale")
    assert response.status_code == 200
    payload = response.json()
    assert payload["rule_version"] == "1.2"
    assert payload["status"] == "recommended"
    assert payload["authored_rationale"] == action["reason"]
    assert "display-only" in payload["advisory_note"]
    unchanged = _r1(client)
    assert unchanged["status"] == "recommended"
    assert unchanged["title"] == action["title"]
    assert unchanged["rule"] == action["rule"]
    assert client.post("/api/responses/REC-NOPE/rationale").status_code == 404
