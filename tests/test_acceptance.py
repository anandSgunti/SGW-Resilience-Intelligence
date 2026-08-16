import json

from sgw_platform.acceptance import MilestoneVerifier
from sgw_platform.synthetic import write_synthetic_data


def test_step_5j_backend_acceptance_gate_passes(tmp_path):
    data_path = write_synthetic_data(tmp_path / "network.json")
    report = MilestoneVerifier(data_path).verify()
    assert report.passed is True
    assert len(report.checks) == 14  # 5J gate, the 6C.3 loop, and 6C.4 transparency
    assert all(check.passed for check in report.checks)
    assert {
        "verification_reassessment_loop",
        "playbook_transparency",
        "recommendation_governance_record",
    } <= {check.check_id for check in report.checks}


def test_acceptance_report_captures_the_critical_transition(tmp_path):
    data_path = write_synthetic_data(tmp_path / "network.json")
    report = MilestoneVerifier(data_path).verify()
    transition = next(
        item for item in report.checks
        if item.check_id == "s17_t48_t24_transition"
    )
    assert transition.passed is True
    assert "restoration 4h->14h" in transition.detail
    assert "gap 0h->8h" in transition.detail
    assert "rank #5->#1" in transition.detail


def test_acceptance_gate_fails_if_authored_signal_is_removed(tmp_path):
    data_path = write_synthetic_data(tmp_path / "network.json")
    payload = json.loads(data_path.read_text(encoding="utf-8"))
    state = next(
        item for item in payload["states"]
        if item["advisory_id"] == "ADV-T24" and item["sgw_id"] == "SGW-S17"
    )
    state["restoration_hours"] = 4
    data_path.write_text(json.dumps(payload), encoding="utf-8")

    report = MilestoneVerifier(data_path).verify()
    assert report.passed is False
    assert next(
        item for item in report.checks
        if item.check_id == "s17_t48_t24_transition"
    ).passed is False
