from dataclasses import replace

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.confidence import ConfidenceEngine
from sgw_platform.consequence import ConsequenceEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import ConfidenceLevel
from sgw_platform.synthetic import write_synthetic_data


def _fixture(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = {asset.sgw_id: asset for asset in adapter.load_assets()}
    advisories = {advisory.advisory_id: advisory for advisory in adapter.load_advisories()}
    states = {
        advisory_id: {state.sgw_id: state for state in adapter.load_states(advisory_id)}
        for advisory_id in advisories
    }
    graph = DependencyGraph(adapter.load_dependencies())
    return assets, advisories, states, graph


def _assess(asset_id, advisory_id, assets, advisories, states, graph):
    consequence = ConsequenceEngine().assess(assets[asset_id], assets, states[advisory_id], advisories[advisory_id], graph)
    return ConfidenceEngine().assess(assets[asset_id], assets, states[advisory_id], advisories[advisory_id], graph, consequence)


def test_s17_confidence_moves_medium_to_high_after_p4_verification(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    t24 = _assess("SGW-S17", "ADV-T24", assets, advisories, states, graph)
    t12 = _assess("SGW-S17", "ADV-T12", assets, advisories, states, graph)
    assert t24.level is ConfidenceLevel.MEDIUM
    assert any("Pump Station P4" in reason and "unverified" in reason for reason in t24.reasons)
    assert t24.verification_actions == ("Verify Pump Station P4 generator and backup readiness",)
    assert t12.level is ConfidenceLevel.HIGH
    assert t12.score > t24.score
    assert t12.verification_actions == ()


def test_stale_and_unverified_evidence_can_produce_low_confidence(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    stale = dict(states["ADV-T24"])
    stale["SGW-S17"] = replace(stale["SGW-S17"], reported_at="2026-08-01T08:00:00Z")
    consequence = ConsequenceEngine().assess(assets["SGW-S17"], assets, stale, advisories["ADV-T24"], graph)
    result = ConfidenceEngine().assess(assets["SGW-S17"], assets, stale, advisories["ADV-T24"], graph, consequence)
    assert result.level is ConfidenceLevel.LOW
    assert any("minutes before" in reason for reason in result.reasons)


def test_missing_material_state_returns_insufficient_data(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    complete_consequence = ConsequenceEngine().assess(assets["SGW-S17"], assets, states["ADV-T24"], advisories["ADV-T24"], graph)
    missing = dict(states["ADV-T24"])
    del missing["SGW-S17"]
    result = ConfidenceEngine().assess(assets["SGW-S17"], assets, missing, advisories["ADV-T24"], graph, complete_consequence)
    assert result.level is ConfidenceLevel.LOW
    assert result.sufficient_data is False
    assert "insufficient data" in result.reasons[0]


def test_confidence_exposes_all_four_evidence_components(tmp_path):
    assets, advisories, states, graph = _fixture(tmp_path)
    result = _assess("SGW-S31", "ADV-T24", assets, advisories, states, graph)
    assert {component.name for component in result.components} == {"completeness", "freshness", "verification", "source_agreement"}
    assert result.level is ConfidenceLevel.HIGH
