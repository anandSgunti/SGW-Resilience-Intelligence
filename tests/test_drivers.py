from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.synthetic import write_synthetic_data


def _timeline(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = adapter.load_assets()
    advisories = adapter.load_advisories()
    states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
    return AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))


def test_current_s17_drivers_are_structured_facts(tmp_path):
    timeline = _timeline(tmp_path)
    s17 = next(item for item in timeline["ADV-T24"] if item.sgw_id == "SGW-S17")
    drivers = {driver.metric: driver for driver in s17.current_drivers}
    assert drivers["effective_population"].value == 58_800
    assert drivers["critical_facilities"].value == 2
    assert drivers["uncovered_hours"].value == 8
    assert drivers["resilience_factor"].value == 1.0


def test_s17_t24_change_pack_explains_the_priority_move(tmp_path):
    timeline = _timeline(tmp_path)
    s17 = next(item for item in timeline["ADV-T24"] if item.sgw_id == "SGW-S17")
    changes = {change.metric: change for change in s17.change_drivers}
    assert (changes["restoration_hours"].previous, changes["restoration_hours"].current) == (4, 14)
    assert (changes["uncovered_hours"].previous, changes["uncovered_hours"].current) == (0, 8)
    assert changes["consequence_score"].current == 96
    assert (changes["risk_tier"].previous, changes["risk_tier"].current) == ("high", "critical")
    assert (changes["rank"].previous, changes["rank"].current) == (5, 1)
    assert s17.primary_change == "Expected restoration now exceeds SGW-P4's 6h backup endurance."


def test_p11_t12_primary_change_is_direct_flood_exposure(tmp_path):
    timeline = _timeline(tmp_path)
    p11 = next(item for item in timeline["ADV-T12"] if item.sgw_id == "SGW-P11")
    flood = next(change for change in p11.change_drivers if change.metric == "flood_depth_m")
    assert flood.current > flood.previous
    assert p11.primary_change.startswith("Direct flood exposure increased")


def test_p4_verification_change_is_exposed_for_s17(tmp_path):
    timeline = _timeline(tmp_path)
    s17 = next(item for item in timeline["ADV-T12"] if item.sgw_id == "SGW-S17")
    verification = next(change for change in s17.change_drivers if change.metric == "verification_status")
    assert verification.previous == "unverified"
    assert verification.current == "verified"
    assert verification.impact == "increased_confidence"
    assert any(change.metric == "confidence_score" for change in s17.change_drivers)


def test_first_advisory_has_no_synthetic_change_claims(tmp_path):
    timeline = _timeline(tmp_path)
    assert all(not item.change_drivers and item.primary_change is None for item in timeline["ADV-T72"])
