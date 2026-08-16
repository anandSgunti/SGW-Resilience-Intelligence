from sgw_platform.assessment import AssessmentEngine
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import RiskTier
from sgw_platform.synthetic import build_synthetic_payload
from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.adapters.source_adapters import SourceRecordIndex
from sgw_platform.synthetic import write_synthetic_data


def _loaded(tmp_path):
    path = write_synthetic_data(tmp_path / "network.json")
    adapter = JsonInfrastructureAdapter(path)
    return adapter, adapter.load_assets(), DependencyGraph(adapter.load_dependencies())


def test_seed_42_is_deterministic():
    assert build_synthetic_payload(42) == build_synthetic_payload(42)
    payload = build_synthetic_payload(42)
    assert len(payload["assets"]) == 40
    assert 30 <= len(payload["dependencies"]) <= 40


def test_canonical_assets_keep_source_aliases(tmp_path):
    _, assets, _ = _loaded(tmp_path)
    s17 = next(asset for asset in assets if asset.sgw_id == "SGW-S17")
    assert s17.source_ids["electric_registry"].startswith("SU-")
    assert len({asset.sgw_id for asset in assets}) == len(assets)


def test_fragmented_source_ids_reconcile_to_one_canonical_asset():
    index = SourceRecordIndex(build_synthetic_payload(42)["source_data"])
    assert index.resolve("gis", "GIS/S17") == "SGW-S17"
    assert index.resolve("field_ops", "OPS-S17") == "SGW-S17"


def test_advisory_state_is_separate_from_stable_identity(tmp_path):
    adapter, assets, _ = _loaded(tmp_path)
    assert len(adapter.load_states("ADV-T24")) == len(assets)
    assert adapter.load_states("ADV-T24") != adapter.load_states("ADV-T0")
    t24 = next(item for item in adapter.load_advisories() if item.advisory_id == "ADV-T24")
    assert t24.event_id == "HURRICANE-IRIS" and t24.changes


def test_hurricane_timeline_encodes_evidence_not_manual_rankings(tmp_path):
    adapter, assets, graph = _loaded(tmp_path)
    states = {advisory_id: {state.sgw_id: state for state in adapter.load_states(advisory_id)} for advisory_id in ["ADV-T48", "ADV-T24", "ADV-T12"]}
    assert states["ADV-T48"]["SGW-S17"].restoration_hours == 4
    assert states["ADV-T24"]["SGW-S17"].restoration_hours == 14
    assert states["ADV-T12"]["SGW-P11"].flood_depth_m > states["ADV-T24"]["SGW-P11"].flood_depth_m
    assert states["ADV-T12"]["SGW-P4"].verification_status == "verified"
    advisory = next(item for item in adapter.load_advisories() if item.advisory_id == "ADV-T24")
    results = {item.sgw_id: item for item in AssessmentEngine().assess(assets, list(states["ADV-T24"].values()), advisory, graph)}
    assert results["SGW-S17"].tier is RiskTier.CRITICAL


def test_authored_golden_chain_is_graph_topology(tmp_path):
    _, _, graph = _loaded(tmp_path)
    descendants = graph.descendants("SGW-S17")
    assert {"SGW-P4", "SGW-W12", "SGW-H3", "SGW-F2"}.issubset(descendants)


def test_full_topology_has_the_locked_resilience_patterns(tmp_path):
    adapter, assets, graph = _loaded(tmp_path)
    assets_by_id = {asset.sgw_id: asset for asset in assets}
    assert assets_by_id["SGW-W12"].attributes["population"] == 84_000
    assert assets_by_id["SGW-W09"].attributes["population"] == 52_000
    assert graph.has_alternate_power("SGW-P9", "SGW-S31")
    assert graph.has_alternate_power("SGW-P7", "SGW-S08")
    assert {"SGW-E1"}.issubset(graph.descendants("SGW-P7"))
    assert {"SGW-D1"}.issubset(graph.descendants("SGW-P11"))


def test_comparison_and_redundancy_are_derived_generically(tmp_path):
    adapter, assets, graph = _loaded(tmp_path)
    advisory = next(a for a in adapter.load_advisories() if a.advisory_id == "ADV-T24")
    assessed = {row.sgw_id: row for row in AssessmentEngine().assess(assets, adapter.load_states(advisory.advisory_id), advisory, graph)}
    assert assessed["SGW-S31"].disruption_likelihood > assessed["SGW-S17"].disruption_likelihood
    assert assessed["SGW-S31"].consequence_score < assessed["SGW-S17"].consequence_score
    assert assessed["SGW-S17"].tier is RiskTier.CRITICAL
    assert assessed["SGW-S31"].tier is RiskTier.HIGH
    assert graph.has_alternate_power("SGW-P7", "SGW-S08")
    assert assessed["SGW-S08"].consequence_score < assessed["SGW-S13"].consequence_score


def test_direct_flood_exposure_changes_pump_likelihood(tmp_path):
    adapter, assets, graph = _loaded(tmp_path)
    advisory = next(a for a in adapter.load_advisories() if a.advisory_id == "ADV-T24")
    assessed = {row.sgw_id: row for row in AssessmentEngine().assess(assets, adapter.load_states("ADV-T24"), advisory, graph)}
    assert assessed["SGW-P11"].disruption_likelihood > 55
