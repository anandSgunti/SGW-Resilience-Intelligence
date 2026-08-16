from dataclasses import replace

import pytest

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import RecommendationStatus
from sgw_platform.playbooks import PlaybookEngine, RecommendationStore
from sgw_platform.synthetic import write_synthetic_data


def _fixture(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    asset_list = adapter.load_assets()
    assets = {asset.sgw_id: asset for asset in asset_list}
    advisories = adapter.load_advisories()
    advisory_map = {advisory.advisory_id: advisory for advisory in advisories}
    states = {
        advisory.advisory_id: adapter.load_states(advisory.advisory_id)
        for advisory in advisories
    }
    timeline = AssessmentEngine().assess_timeline(
        asset_list,
        advisories,
        states,
        DependencyGraph(adapter.load_dependencies()),
    )
    return assets, advisory_map, timeline


def test_s17_playbook_is_derived_from_t24_assessment(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    recommendations = PlaybookEngine().evaluate(
        timeline["ADV-T24"], assets, advisories["ADV-T24"]
    )
    s17 = [item for item in recommendations if item.asset_id == "SGW-S17"]

    assert [item.rule_id for item in s17] == ["R1", "R2", "R3", "R5"]
    generation = next(item for item in s17 if item.rule_id == "R1")
    assert generation.target_asset_id == "SGW-P4"
    assert {fact.metric: fact.value for fact in generation.facts} == {
        "restoration_hours": 14.0,
        "backup_hours": 6.0,
        "uncovered_hours": 8.0,
    }
    assert next(item for item in s17 if item.rule_id == "R2").target_asset_id == "SGW-P4"


def test_more_likely_s31_does_not_receive_critical_rules(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    recommendations = PlaybookEngine().evaluate(
        timeline["ADV-T24"], assets, advisories["ADV-T24"]
    )
    assert not [item for item in recommendations if item.asset_id == "SGW-S31"]


def test_directly_flood_exposed_water_asset_triggers_r4(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    recommendations = PlaybookEngine().evaluate(
        timeline["ADV-T12"], assets, advisories["ADV-T12"]
    )
    flood_action = next(
        item for item in recommendations
        if item.asset_id == "SGW-P11" and item.rule_id == "R4"
    )
    facts = {fact.metric: fact.value for fact in flood_action.facts}
    assert facts["flood_depth_m"] >= 1.2
    assert facts["threshold_m"] == .9


def test_recommendation_ids_and_order_are_deterministic(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    engine = PlaybookEngine()
    first = engine.evaluate(timeline["ADV-T24"], assets, advisories["ADV-T24"])
    second = engine.evaluate(timeline["ADV-T24"], assets, advisories["ADV-T24"])
    assert [item.recommendation_id for item in first] == [
        item.recommendation_id for item in second
    ]


def test_existing_active_mitigation_suppresses_r5(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    engine = PlaybookEngine()
    baseline = engine.evaluate(timeline["ADV-T24"], assets, advisories["ADV-T24"])
    active = replace(
        next(item for item in baseline if item.asset_id == "SGW-S17" and item.rule_id == "R1"),
        status=RecommendationStatus.APPROVED,
    )
    updated = engine.evaluate(
        timeline["ADV-T24"], assets, advisories["ADV-T24"], existing=[active]
    )
    assert not [
        item for item in updated
        if item.asset_id == "SGW-S17" and item.rule_id == "R5"
    ]


def test_human_lifecycle_preserves_immutable_audit_history(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    recommendation = PlaybookEngine().evaluate(
        timeline["ADV-T24"], assets, advisories["ADV-T24"]
    )[0]
    store = RecommendationStore()
    original = store.add(recommendation)
    approved = store.transition(
        original.recommendation_id,
        RecommendationStatus.APPROVED,
        "Jett Morgan",
        occurred_at="2026-08-16T10:00:00+00:00",
    )
    assigned = store.transition(
        original.recommendation_id,
        RecommendationStatus.ASSIGNED,
        "Jett Morgan",
        owner="Field Operations",
        occurred_at="2026-08-16T10:05:00+00:00",
    )
    store.transition(
        original.recommendation_id,
        RecommendationStatus.IN_PROGRESS,
        "Taylor Singh",
        occurred_at="2026-08-16T10:20:00+00:00",
    )
    completed = store.transition(
        original.recommendation_id,
        RecommendationStatus.COMPLETED,
        "Taylor Singh",
        occurred_at="2026-08-16T12:45:00+00:00",
        reason="Temporary generator connected and load-tested.",
    )

    assert original.history == ()
    assert approved.status is RecommendationStatus.APPROVED
    assert assigned.owner == "Field Operations"
    assert [event.status for event in completed.history] == [
        RecommendationStatus.APPROVED,
        RecommendationStatus.ASSIGNED,
        RecommendationStatus.IN_PROGRESS,
        RecommendationStatus.COMPLETED,
    ]
    assert completed.history[-1].reason == "Temporary generator connected and load-tested."


def test_lifecycle_rejects_unattributed_or_invalid_decisions(tmp_path):
    assets, advisories, timeline = _fixture(tmp_path)
    recommendation = PlaybookEngine().evaluate(
        timeline["ADV-T24"], assets, advisories["ADV-T24"]
    )[0]
    store = RecommendationStore()
    store.add(recommendation)

    with pytest.raises(ValueError, match="human actor"):
        store.transition(recommendation.recommendation_id, RecommendationStatus.APPROVED, " ")
    with pytest.raises(ValueError, match="rejection reason"):
        store.transition(recommendation.recommendation_id, RecommendationStatus.REJECTED, "Jett")
    with pytest.raises(ValueError, match="Invalid transition"):
        store.transition(recommendation.recommendation_id, RecommendationStatus.COMPLETED, "Jett")
    with pytest.raises(ValueError, match="already exists"):
        store.add(recommendation)
