from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.consequence import ConsequenceEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.synthetic import write_synthetic_data


def _fixture(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = {asset.sgw_id: asset for asset in adapter.load_assets()}
    advisories = {advisory.advisory_id: advisory for advisory in adapter.load_advisories()}
    states = {
        advisory_id: {state.sgw_id: state for state in adapter.load_states(advisory_id)}
        for advisory_id in advisories
    }
    return adapter, assets, advisories, states, DependencyGraph(adapter.load_dependencies())


def _assess(engine, asset_id, advisory_id, assets, advisories, states, graph):
    return engine.assess(assets[asset_id], assets, states[advisory_id], advisories[advisory_id], graph)


def test_s17_consequence_jumps_when_backup_window_is_exceeded(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    engine = ConsequenceEngine()
    t48 = _assess(engine, "SGW-S17", "ADV-T48", assets, advisories, states, graph)
    t24 = _assess(engine, "SGW-S17", "ADV-T24", assets, advisories, states, graph)
    assert t48.max_uncovered_hours == 0
    assert t24.max_uncovered_hours == 8
    assert t24.effective_population == 58_800
    assert set(t24.critical_facilities) == {"Hospital H3", "Fire Station F2"}
    assert t24.score == 96
    assert t24.score > t48.score


def test_s31_is_constrained_by_backup_and_partial_alternate_feed(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    result = _assess(ConsequenceEngine(), "SGW-S31", "ADV-T24", assets, advisories, states, graph)
    assert result.max_uncovered_hours == 0
    assert result.paths[0].backup_hours == 18
    assert result.paths[0].resilience_factor == .7
    assert 50 <= result.score <= 57


def test_full_redundancy_reduces_s08_path_consequence(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    result = _assess(ConsequenceEngine(), "SGW-S08", "ADV-T24", assets, advisories, states, graph)
    assert result.paths[0].resilience_factor == .4
    assert result.paths[0].adjusted_impact < result.paths[0].exposure_score


def test_p11_has_direct_water_service_consequence(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    result = _assess(ConsequenceEngine(), "SGW-P11", "ADV-T12", assets, advisories, states, graph)
    assert result.paths[0].backup_hours == 4
    assert result.effective_population == 20_500
    assert result.critical_facilities == ("Dialysis Centre D1",)
    assert result.score > result.base_consequence


def test_assets_without_downstream_graph_keep_base_consequence(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    result = _assess(ConsequenceEngine(), "SGW-S01", "ADV-T24", assets, advisories, states, graph)
    assert result.paths == ()
    assert result.score == result.base_consequence > 0


def test_verification_changes_confidence_later_not_consequence(tmp_path):
    _, assets, advisories, states, graph = _fixture(tmp_path)
    engine = ConsequenceEngine()
    t24 = _assess(engine, "SGW-S17", "ADV-T24", assets, advisories, states, graph)
    t12 = _assess(engine, "SGW-S17", "ADV-T12", assets, advisories, states, graph)
    assert states["ADV-T24"]["SGW-P4"].verification_status == "unverified"
    assert states["ADV-T12"]["SGW-P4"].verification_status == "verified"
    assert t24.score == t12.score == 96
