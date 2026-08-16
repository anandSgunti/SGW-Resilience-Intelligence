from pathlib import Path

import pytest

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import TemplateNarrator
from sgw_platform.models import ActionClass, FieldOutcome, RiskTier


DATA = Path(__file__).parents[1] / "data" / "synthetic_sgw.json"


def _platform() -> PlatformApplication:
    return PlatformApplication(JsonInfrastructureAdapter(DATA), narrator=TemplateNarrator())


def _verification_action(platform: PlatformApplication, stage: str = "T-24"):
    advisory = platform.resolve_advisory(stage)
    return next(
        item for item in platform._ensure_recommendations(advisory)
        if item.action_class is ActionClass.FIELD_VERIFICATION
    )


def _run_to_in_progress(platform: PlatformApplication, action):
    platform.decide_response(action.recommendation_id, "approve", "Ops Lead")
    platform.decide_response(action.recommendation_id, "assign", "Ops Lead", owner="Field Operations")
    platform.decide_response(action.recommendation_id, "start", "Field Technician")


def test_playbooks_label_verification_work_without_naming_rule_ids():
    platform = _platform()
    actions = platform._ensure_recommendations(platform.resolve_advisory("T-24"))
    classes = {item.action_class for item in actions}
    assert ActionClass.FIELD_VERIFICATION in classes
    assert ActionClass.MITIGATION in classes
    verification = _verification_action(platform)
    assert verification.target_asset_id in platform.assets_by_id


def test_verified_readiness_lifts_confidence_without_moving_risk():
    platform = _platform()
    action = _verification_action(platform)
    source = action.asset_id
    before = platform.assessment(source, "ADV-T24")
    _run_to_in_progress(platform, action)
    _, verification = platform.decide_response(
        action.recommendation_id, "complete", "Field Technician",
        reason="Site check complete.",
        result={"outcome": "verified_operational", "detail": "Generator operational", "confirmed_backup_hours": 6},
    )
    after = platform.assessment(source, "ADV-T24")
    assert verification is not None
    assert verification.outcome is FieldOutcome.VERIFIED_OPERATIONAL
    assert after.confidence == "high" and before.confidence == "medium"
    assert after.risk_score == before.risk_score
    assert after.tier is before.tier


def test_unavailable_backup_widens_the_gap_and_worsens_the_verified_asset():
    platform = _platform()
    action = _verification_action(platform)
    target, source = action.target_asset_id, action.asset_id
    target_before = platform.assessment(target, "ADV-T24")
    source_before = platform.assessment(source, "ADV-T24")
    _run_to_in_progress(platform, action)
    _, verification = platform.decide_response(
        action.recommendation_id, "complete", "Field Technician",
        reason="No usable generator on site.",
        result={"outcome": "unavailable", "detail": "Generator unavailable"},
    )
    target_after = platform.assessment(target, "ADV-T24")
    source_after = platform.assessment(source, "ADV-T24")
    assert verification.outcome is FieldOutcome.UNAVAILABLE
    assert target_after.consequence_score > target_before.consequence_score
    assert target_after.risk_score > target_before.risk_score
    assert target_after.tier is RiskTier.HIGH and target_before.tier is RiskTier.MEDIUM
    # The dependent asset loses its backup cover even though its capped score holds.
    assert source_after.max_uncovered_hours > source_before.max_uncovered_hours


def test_verification_preserves_a_before_and_after_audit_trail():
    platform = _platform()
    action = _verification_action(platform)
    _run_to_in_progress(platform, action)
    _, verification = platform.decide_response(
        action.recommendation_id, "complete", "Field Technician",
        reason="Confirmed on site.",
        occurred_at="2026-09-03T13:42:00+00:00",
        result={"outcome": "verified_operational", "detail": "Generator operational", "verified_by": "Field Ops"},
    )
    assert "At T-24" in verification.narrative
    assert "unverified" in verification.narrative
    assert "13:42" in verification.narrative
    assert "Field Ops" in verification.narrative
    before_ids = {item.sgw_id for item in verification.before}
    after_ids = {item.sgw_id for item in verification.after}
    assert before_ids == after_ids and action.target_asset_id in before_ids
    assert any(item.metric == "verification_status" for item in verification.impacts)
    assert verification.recommendation_id == action.recommendation_id


def test_confirmed_state_carries_forward_to_later_advisories():
    platform = _platform()
    action = _verification_action(platform)
    _run_to_in_progress(platform, action)
    _, verification = platform.decide_response(
        action.recommendation_id, "complete", "Field Technician",
        reason="Confirmed on site.",
        result={"outcome": "unavailable", "detail": "Generator unavailable"},
    )
    assert verification.applied_to_advisories == ("ADV-T24", "ADV-T12", "ADV-T0")
    assert "ADV-T72" not in verification.applied_to_advisories
    for advisory_id in verification.applied_to_advisories:
        state = next(item for item in platform.states[advisory_id] if item.sgw_id == verification.verified_asset_id)
        assert state.backup_available_hours == 0.0 and state.verification_status == "verified"


def test_closed_evidence_gap_stops_regenerating_the_verification_action():
    platform = _platform()
    action = _verification_action(platform)
    advisory = platform.resolve_advisory("T-24")
    _run_to_in_progress(platform, action)
    platform.decide_response(
        action.recommendation_id, "complete", "Field Technician",
        reason="Confirmed on site.",
        result={"outcome": "verified_operational", "detail": "Generator operational"},
    )
    regenerated = platform.playbooks.evaluate(
        platform.timeline["ADV-T24"], platform.assets_by_id, advisory
    )
    assert not [item for item in regenerated if item.action_class is ActionClass.FIELD_VERIFICATION]
    # The completed record itself is never dropped from the audit history.
    queue = platform._ensure_recommendations(advisory)
    completed = next(item for item in queue if item.recommendation_id == action.recommendation_id)
    assert completed.status.value == "completed" and len(completed.history) == 4


def test_field_results_are_rejected_outside_the_verification_completion_path():
    platform = _platform()
    verification_action = _verification_action(platform)
    mitigation = next(
        item for item in platform._ensure_recommendations(platform.resolve_advisory("T-24"))
        if item.action_class is ActionClass.MITIGATION
    )
    result = {"outcome": "verified_operational", "detail": "x"}
    with pytest.raises(ValueError, match="verification action"):
        platform.decide_response(mitigation.recommendation_id, "approve", "Ops Lead", result=result)
    with pytest.raises(ValueError, match="completing the action"):
        platform.decide_response(verification_action.recommendation_id, "approve", "Ops Lead", result=result)


def test_unknown_outcomes_and_unattributed_results_are_refused():
    platform = _platform()
    with pytest.raises(ValueError, match="Unknown field verification outcome"):
        platform.record_field_verification("SGW-P4", "looks_fine", "Field Ops", advisory_value="T-24")
    with pytest.raises(ValueError, match="verifying field operator"):
        platform.record_field_verification("SGW-P4", "verified_operational", "  ", advisory_value="T-24")
    with pytest.raises(KeyError):
        platform.record_field_verification("SGW-NOPE", "verified_operational", "Field Ops", advisory_value="T-24")


def test_verification_history_is_exposed_to_every_screen():
    platform = _platform()
    platform.record_field_verification(
        "SGW-P4", "verified_operational", "Field Ops",
        detail="Generator operational", advisory_value="T-24", confirmed_backup_hours=6,
    )
    state = platform.current_state("T-24")
    assert len(state["verifications"]) == 1
    # The dependent asset sees the history but its own observation is untouched.
    detail = platform.asset_detail("SGW-S17", "T-24")
    assert len(detail["verification_history"]) == 1
    assert detail["state"]["source"] == "field_ops"
    target_detail = platform.asset_detail("SGW-P4", "T-24")
    assert target_detail["state"]["verification_status"] == "verified"
    assert target_detail["state"]["source"] == "field_verification"
    assert target_detail["state"]["reported_by"] == "Field Ops"
