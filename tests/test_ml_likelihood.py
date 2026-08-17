"""Tests for the experimental ML disruption-likelihood track.

Two things are under test here. First, that the model is a genuinely fitted
scikit-learn estimator rather than a wrapper around a formula. Second, and more
important, that it is *architecturally separate*: the operational risk pipeline
must produce byte-identical output whether or not the model runs at all.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.application import PlatformApplication
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.explanations import TemplateNarrator
from sgw_platform.likelihood import LikelihoodEngine
from sgw_platform.ml.likelihood_model import (
    DISRUPTION_MODEL,
    MODEL_NAME,
    MODEL_VERSION,
    DisruptionLikelihoodModel,
    features_from_state,
)
from sgw_platform.ml.training_data import (
    FEATURE_ORDER,
    TRAINING_ROWS,
    build_training_set,
)

DATA = Path(__file__).parents[1] / "data" / "synthetic_sgw.json"


def _platform(**kwargs) -> PlatformApplication:
    return PlatformApplication(
        JsonInfrastructureAdapter(DATA), narrator=TemplateNarrator(), **kwargs
    )


# --- the dataset -----------------------------------------------------------


def test_training_set_is_deterministic_and_correctly_shaped():
    first = build_training_set()
    second = build_training_set()
    assert first.rows == second.rows, "same seed must yield the same table"
    assert len(first.rows) == TRAINING_ROWS
    assert set(first.features[0]) == set(FEATURE_ORDER)


def test_training_labels_are_not_degenerate():
    """A constant label would let a broken model score a perfect fit."""
    rate = build_training_set().positive_rate
    assert 0.2 < rate < 0.8, f"positive rate {rate} is too imbalanced to learn from"


def test_training_data_encodes_no_demo_asset():
    """The model must not have been taught the scenario it is scoring."""
    text = (
        Path(__file__).parents[1] / "src" / "sgw_platform" / "ml" / "training_data.py"
    ).read_text(encoding="utf-8")
    assert "SGW-" not in text


# --- the estimator ---------------------------------------------------------


def test_estimator_is_a_fitted_sklearn_logistic_regression():
    sklearn_linear = pytest.importorskip("sklearn.linear_model")
    from sklearn.utils.validation import check_is_fitted

    pipeline = DISRUPTION_MODEL.pipeline
    assert pipeline is not None
    estimator = pipeline.named_steps["estimator"]
    assert isinstance(estimator, sklearn_linear.LogisticRegression)
    check_is_fitted(estimator)  # raises if the coefficients were never learned


def test_coefficients_recover_the_generative_direction():
    """Learned signs must match the synthetic world, or nothing was learned."""
    coefficients = DISRUPTION_MODEL.coefficients()
    assert coefficients["wind_gust_kph"] > 0
    assert coefficients["flood_depth_m"] > 0
    assert coefficients["previous_failures"] > 0
    # Higher condition score means a healthier asset, so the weight is negative.
    assert coefficients["condition_score"] < 0


def test_predictions_are_deterministic_and_bounded():
    platform = _platform()
    asset = platform.assets_by_id["SGW-S17"]
    advisory = platform.advisories_by_id["ADV-T24"]
    state = next(
        item for item in platform.states["ADV-T24"] if item.sgw_id == "SGW-S17"
    )
    features = features_from_state(asset, state, advisory)

    first = DISRUPTION_MODEL.predict(features)
    second = DisruptionLikelihoodModel().predict(features)
    assert first is not None and second is not None
    assert first.likelihood == second.likelihood, "a fresh fit must agree"
    assert 0.0 <= first.likelihood <= 100.0


def test_prediction_features_match_the_training_schema():
    """A drifted feature name maps a column to the wrong weight, silently."""
    platform = _platform()
    asset = platform.assets_by_id["SGW-S31"]
    advisory = platform.advisories_by_id["ADV-T24"]
    state = next(
        item for item in platform.states["ADV-T24"] if item.sgw_id == "SGW-S31"
    )
    assert set(features_from_state(asset, state, advisory)) == set(FEATURE_ORDER)


def test_drivers_are_reported_with_provenance():
    assessment = _platform().assessment("SGW-S17", "ADV-T24")
    assert assessment.model_name == MODEL_NAME
    assert assessment.model_version == MODEL_VERSION
    assert assessment.experimental_ml_drivers, "an estimate without drivers is opaque"


# --- the separation guarantee ----------------------------------------------


def test_operational_likelihood_is_always_the_deterministic_scorecard():
    for assessment in _platform().current_state("T-24")["assessments"]:
        assert assessment["likelihood_source"] == "deterministic-baseline"


def test_ml_track_does_not_move_risk_tier_or_rank():
    """The load-bearing test for the dual-track claim.

    Disabling the model entirely must leave every operational number identical.
    If this fails, the ML estimate has leaked into the decision path.
    """
    with_model = _platform()
    without_model = _platform(
        assessment_engine=AssessmentEngine(
            likelihood_engine=LikelihoodEngine(use_model=False)
        )
    )
    for advisory_id in with_model.timeline:
        paired = zip(with_model.timeline[advisory_id], without_model.timeline[advisory_id])
        for scored, plain in paired:
            assert scored.sgw_id == plain.sgw_id
            assert scored.disruption_likelihood == plain.disruption_likelihood
            assert scored.risk_score == plain.risk_score
            assert scored.tier == plain.tier
            assert scored.rank == plain.rank


def test_platform_still_works_when_the_model_is_unavailable():
    broken = DisruptionLikelihoodModel()
    broken._unavailable = True  # simulate a missing or unloadable scikit-learn
    engine = LikelihoodEngine(model=broken)
    platform = _platform(assessment_engine=AssessmentEngine(likelihood_engine=engine))

    assessment = platform.assessment("SGW-S17", "ADV-T24")
    assert assessment.experimental_ml_likelihood is None
    assert assessment.tier.value == "critical", "the scorecard must carry the scenario alone"
    assert assessment.rank == 1


def test_confidence_does_not_alter_likelihood_or_risk():
    """Confidence describes evidence quality; it must never move the score."""
    assessment = _platform().assessment("SGW-S17", "ADV-T24")
    expected = min(
        100,
        round(assessment.disruption_likelihood * assessment.consequence_score / 100, 1),
    )
    assert assessment.risk_score == expected


# --- the scenario the two tracks are meant to illuminate --------------------


def test_ml_ranks_the_degraded_asset_above_the_critical_one():
    """S31 is in worse physical condition, and the model says so.

    It has no access to the authored `disruption_baseline` prior, so this is
    the model's own reading of condition, age and failure history.
    """
    platform = _platform()
    s17 = platform.assessment("SGW-S17", "ADV-T24")
    s31 = platform.assessment("SGW-S31", "ADV-T24")
    assert s31.experimental_ml_likelihood > s17.experimental_ml_likelihood


def test_systemic_ranking_still_puts_the_cascading_asset_first():
    """And the platform still disagrees with the model, for a stated reason.

    S17 outranks S31 on consequence, not likelihood. That is the whole thesis:
    disruption probability alone is the wrong prioritisation signal.
    """
    platform = _platform()
    s17 = platform.assessment("SGW-S17", "ADV-T24")
    s31 = platform.assessment("SGW-S31", "ADV-T24")
    assert s17.rank < s31.rank
    assert s17.consequence_score > s31.consequence_score


# --- the output only the two tracks together can produce --------------------


def test_baseline_divergence_uses_a_distribution_rule_not_a_tuned_cutoff():
    """The threshold must be derived from the network, not chosen.

    A fixed cutoff invites being tuned until it captures whichever asset the
    demo wants to discuss. This one is mean + 1 standard deviation of the
    network's own divergence, recomputed per advisory.
    """
    report = _platform().baseline_divergence("T-24")
    assert report["rule"] == "mean + 1 standard deviation of network divergence"
    # The threshold is derived before rounding, so it can sit up to 0.1 from
    # the sum of the two separately-rounded components it is reported beside.
    assert report["threshold"] == pytest.approx(
        report["mean_divergence"] + report["standard_deviation"], abs=0.2
    )
    assert report["population"] == 40


def test_baseline_divergence_reports_whatever_qualifies():
    report = _platform().baseline_divergence("T-24")
    threshold = report["threshold"]
    assert report["total"] > 0
    for finding in report["findings"]:
        assert abs(finding["delta"]) >= threshold
        assert finding["direction"] in {"model_higher", "model_lower"}
        # Each finding must name the susceptibility assumption it questions.
        assert f"{finding['authored_baseline']:.2f}" in finding["finding"]
    deltas = [abs(item["delta"]) for item in report["findings"]]
    assert deltas == sorted(deltas, reverse=True), "widest divergence first"


def test_divergence_does_not_overclaim_against_the_operational_figure():
    """Wording guard.

    The shadow model trains on synthetic data, so it is not independent
    real-world evidence and must never be phrased as proving the operational
    baseline wrong.
    """
    report = _platform().baseline_divergence("T-24")
    forbidden = ("does not support", "incorrect", "wrong", "understates", "proves")
    for finding in report["findings"]:
        lowered = finding["finding"].casefold()
        assert not any(word in lowered for word in forbidden)
        assert "candidate for review" in lowered
    assert "not independent real-world evidence" in report["note"]


def test_s17_is_not_force_fitted_into_the_review_queue():
    """S17 diverges by less than the network mean and must be excluded.

    The demo's headline asset does not qualify, and the rule is not bent so it
    does. Its comparison remains visible on the asset page.
    """
    report = _platform().baseline_divergence("T-24")
    assert "SGW-S17" not in {item["sgw_id"] for item in report["findings"]}

    assessment = _platform().assessment("SGW-S17", "ADV-T24")
    divergence = abs(assessment.experimental_ml_likelihood - assessment.disruption_likelihood)
    assert divergence < report["threshold"]
    assert assessment.experimental_ml_likelihood is not None, "comparison still available"


def test_baseline_divergence_is_empty_without_the_model():
    """No second opinion, no disagreement, and no invented findings."""
    platform = _platform(
        assessment_engine=AssessmentEngine(
            likelihood_engine=LikelihoodEngine(use_model=False)
        )
    )
    report = platform.baseline_divergence("T-24")
    assert report["total"] == 0
    assert report["findings"] == []
