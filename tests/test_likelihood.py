from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.likelihood import LikelihoodEngine
from sgw_platform.synthetic import write_synthetic_data


def _fixture(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = {asset.sgw_id: asset for asset in adapter.load_assets()}
    advisories = {advisory.advisory_id: advisory for advisory in adapter.load_advisories()}
    states = {
        advisory_id: {state.sgw_id: state for state in adapter.load_states(advisory_id)}
        for advisory_id in advisories
    }
    return assets, advisories, states


def test_every_asset_receives_a_bounded_likelihood(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    engine = LikelihoodEngine()
    results = [engine.assess(asset, states["ADV-T24"][asset.sgw_id], advisories["ADV-T24"]) for asset in assets.values()]
    assert len(results) == len(assets)
    assert all(0 <= result.score <= 98 for result in results)


def test_t24_comparison_is_driven_by_asset_inputs(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    engine = LikelihoodEngine()
    s17 = engine.assess(assets["SGW-S17"], states["ADV-T24"]["SGW-S17"], advisories["ADV-T24"])
    s31 = engine.assess(assets["SGW-S31"], states["ADV-T24"]["SGW-S31"], advisories["ADV-T24"])
    assert 70 <= s17.score <= 73
    assert 82 <= s31.score <= 86
    assert s31.score > s17.score


def test_direct_flood_hazard_raises_p11_likelihood(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    engine = LikelihoodEngine()
    t24 = engine.assess(assets["SGW-P11"], states["ADV-T24"]["SGW-P11"], advisories["ADV-T24"])
    t12 = engine.assess(assets["SGW-P11"], states["ADV-T12"]["SGW-P11"], advisories["ADV-T12"])
    assert t12.score > t24.score
    assert next(component for component in t12.components if component.name == "direct_hazard_stress").points > 0


def test_components_are_explainable_and_deterministic(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    engine = LikelihoodEngine()
    first = engine.assess(assets["SGW-S17"], states["ADV-T24"]["SGW-S17"], advisories["ADV-T24"])
    second = engine.assess(assets["SGW-S17"], states["ADV-T24"]["SGW-S17"], advisories["ADV-T24"])
    assert first == second
    assert first.raw_score == round(sum(component.points for component in first.components), 1)
    assert first.drivers


def test_likelihood_api_has_no_dependency_graph_input(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    result = LikelihoodEngine().assess(assets["SGW-S08"], states["ADV-T24"]["SGW-S08"], advisories["ADV-T24"])
    assert result.sgw_id == "SGW-S08"


def test_location_derived_wind_observation_drives_storm_component(tmp_path):
    assets, advisories, states = _fixture(tmp_path)
    engine = LikelihoodEngine()
    state = states["ADV-T24"]["SGW-S17"]
    result = engine.assess(assets["SGW-S17"], state, advisories["ADV-T24"])
    component = next(item for item in result.components if item.name == "local_storm_exposure")
    assert component.points == round((state.wind_gust_kph - 35) / 95 * 50, 1)


def test_authored_clusters_occupy_distinct_operating_zones(tmp_path):
    assets, _, _ = _fixture(tmp_path)
    assert assets["SGW-S17"].attributes["operating_zone"] == "coastal"
    assert assets["SGW-P11"].attributes["operating_zone"] == "inland_flood"
    assert assets["SGW-S31"].attributes["operating_zone"] == "inland_resilient"
