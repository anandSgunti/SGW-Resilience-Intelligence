from dataclasses import replace

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine, tier_for_score
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import RiskTier
from sgw_platform.synthetic import write_synthetic_data


def _fixture(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = adapter.load_assets()
    advisories = adapter.load_advisories()
    states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
    graph = DependencyGraph(adapter.load_dependencies())
    return assets, advisories, states, graph


def test_prototype_tier_thresholds_are_deterministic():
    assert tier_for_score(19.9) is RiskTier.LOW
    assert tier_for_score(20) is RiskTier.MEDIUM
    assert tier_for_score(39.9) is RiskTier.MEDIUM
    assert tier_for_score(40) is RiskTier.HIGH
    assert tier_for_score(59.9) is RiskTier.HIGH
    assert tier_for_score(60) is RiskTier.CRITICAL


def test_systemic_risk_is_likelihood_times_consequence(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    advisory = next(item for item in advisories if item.advisory_id == "ADV-T24")
    results = {item.sgw_id: item for item in AssessmentEngine().assess(assets, states["ADV-T24"], advisory, graph)}
    for result in results.values():
        assert result.risk_score == round(result.disruption_likelihood * result.consequence_score / 100, 1)


def test_s17_outranks_more_likely_s31_at_t24(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    advisory = next(item for item in advisories if item.advisory_id == "ADV-T24")
    results = {item.sgw_id: item for item in AssessmentEngine().assess(assets, states["ADV-T24"], advisory, graph)}
    assert results["SGW-S31"].disruption_likelihood > results["SGW-S17"].disruption_likelihood
    assert results["SGW-S17"].tier is RiskTier.CRITICAL
    assert results["SGW-S31"].tier is RiskTier.HIGH
    assert results["SGW-S17"].rank < results["SGW-S31"].rank


def test_authored_timeline_produces_real_rank_movement(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    timeline = AssessmentEngine().assess_timeline(assets, advisories, states, graph)
    t48 = {item.sgw_id: item for item in timeline["ADV-T48"]}
    t24 = {item.sgw_id: item for item in timeline["ADV-T24"]}
    assert t48["SGW-S17"].rank == 5
    assert t24["SGW-S17"].rank == 1 and t24["SGW-S17"].rank_change == 4
    assert t24["SGW-S31"].rank == 2


def test_timeline_records_previous_rank_and_movement(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    timeline = AssessmentEngine().assess_timeline(assets, advisories, states, graph)
    first = {item.sgw_id: item for item in timeline[advisories[0].advisory_id]}
    assert all(item.previous_rank is None and item.rank_change is None for item in first.values())
    for previous_advisory, current_advisory in zip(advisories, advisories[1:]):
        previous = {item.sgw_id: item for item in timeline[previous_advisory.advisory_id]}
        current = {item.sgw_id: item for item in timeline[current_advisory.advisory_id]}
        for asset_id, assessment in current.items():
            assert assessment.previous_rank == previous[asset_id].rank
            assert assessment.rank_change == assessment.previous_rank - assessment.rank


def test_confidence_does_not_change_systemic_risk(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    advisory = next(item for item in advisories if item.advisory_id == "ADV-T24")
    baseline = {item.sgw_id: item for item in AssessmentEngine().assess(assets, states["ADV-T24"], advisory, graph)}
    changed_states = [replace(state, verification_status="verified") if state.sgw_id == "SGW-P4" else state for state in states["ADV-T24"]]
    changed = {item.sgw_id: item for item in AssessmentEngine().assess(assets, changed_states, advisory, graph)}
    assert baseline["SGW-S17"].confidence != changed["SGW-S17"].confidence
    assert baseline["SGW-S17"].risk_score == changed["SGW-S17"].risk_score


def test_ranking_uses_documented_tie_breakers(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    advisory = next(item for item in advisories if item.advisory_id == "ADV-T24")
    results = AssessmentEngine().assess(assets, states["ADV-T24"], advisory, graph)
    expected = sorted(results, key=lambda item: (-item.risk_score, -item.consequence_score, -item.disruption_likelihood, item.sgw_id))
    assert [item.sgw_id for item in results] == [item.sgw_id for item in expected]
