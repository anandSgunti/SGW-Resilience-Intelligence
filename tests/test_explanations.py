from types import SimpleNamespace

import pytest

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.explanations import (
    ExplanationService,
    FactPackBuilder,
    OpenAIResponsesNarrator,
    TemplateNarrator,
    UngroundedExplanationError,
)
from sgw_platform.graph import DependencyGraph
from sgw_platform.synthetic import write_synthetic_data


def _assessment(tmp_path):
    adapter = JsonInfrastructureAdapter(write_synthetic_data(tmp_path / "network.json"))
    assets = adapter.load_assets()
    assets_by_id = {asset.sgw_id: asset for asset in assets}
    advisories = adapter.load_advisories()
    advisories_by_id = {advisory.advisory_id: advisory for advisory in advisories}
    states = {advisory.advisory_id: adapter.load_states(advisory.advisory_id) for advisory in advisories}
    timeline = AssessmentEngine().assess_timeline(assets, advisories, states, DependencyGraph(adapter.load_dependencies()))
    assessment = next(item for item in timeline["ADV-T24"] if item.sgw_id == "SGW-S17")
    return assets_by_id["SGW-S17"], advisories_by_id["ADV-T24"], assessment


class FakeResponses:
    def __init__(self, text):
        self.text = text
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(output_text=self.text)


def test_fact_pack_contains_deterministic_outputs_not_source_records(tmp_path):
    asset, advisory, assessment = _assessment(tmp_path)
    fact_pack = FactPackBuilder.build(asset, advisory, assessment)
    assert fact_pack["assessment"]["systemic_risk_score"] == 60.7
    assert fact_pack["assessment"]["uncovered_hours"] == 8
    assert fact_pack["primary_change"].startswith("Expected restoration")
    assert "source_ids" not in fact_pack["asset"]


def test_openai_adapter_uses_responses_api_without_storage(tmp_path):
    asset, advisory, assessment = _assessment(tmp_path)
    responses = FakeResponses("S17 is critical at 60.7, driven by an 8-hour uncovered window. Confidence is medium.")
    client = SimpleNamespace(responses=responses)
    narrator = OpenAIResponsesNarrator(model="gpt-5.6-luna", client=client)
    result = ExplanationService(narrator).explain(asset, advisory, assessment)
    assert result.grounded is True
    assert result.model == "gpt-5.6-luna"
    assert responses.kwargs["store"] is False
    assert responses.kwargs["reasoning"] == {"effort": "none"}
    assert responses.kwargs["model"] == "gpt-5.6-luna"


def test_numeric_grounding_guard_rejects_invented_claim(tmp_path):
    asset, advisory, assessment = _assessment(tmp_path)
    client = SimpleNamespace(responses=FakeResponses("S17 affects 999000 residents."))
    with pytest.raises(UngroundedExplanationError):
        ExplanationService(OpenAIResponsesNarrator(client=client)).explain(asset, advisory, assessment)


def test_fact_pack_hash_and_offline_explanation_are_repeatable(tmp_path):
    asset, advisory, assessment = _assessment(tmp_path)
    service = ExplanationService(TemplateNarrator())
    first = service.explain(asset, advisory, assessment)
    second = service.explain(asset, advisory, assessment)
    assert first == second
    assert len(first.fact_pack_sha256) == 64
    assert "60.7" in first.text
