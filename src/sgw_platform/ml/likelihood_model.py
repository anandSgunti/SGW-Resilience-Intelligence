"""Trained disruption-likelihood model and the feature bridge to live state.

The estimator is a scikit-learn `LogisticRegression` inside a `Pipeline`, so
scaling and categorical encoding travel with the model and inference cannot
drift from training. It is fitted once, lazily, and cached.

The output is a *relative synthetic prototype estimate*. It is trained on
generated history, not on SGW outcomes, and is not a validated failure
probability.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sgw_platform.ml.training_data import (
    CATEGORICAL_FEATURES,
    FEATURE_ORDER,
    NUMERIC_FEATURES,
    TRAINING_SEED,
    build_training_set,
)

MODEL_NAME = "Logistic Regression"
MODEL_VERSION = "1.0.0"
SOURCE_ML = "shadow-logistic-regression"
SOURCE_FALLBACK = "deterministic-baseline"
TRAINING_DESCRIPTION = "Synthetic historical training data"
DEPLOYMENT_MODE = "shadow"


@dataclass(frozen=True)
class ModelPrediction:
    """One inference plus enough provenance to explain it on screen."""

    likelihood: float
    model_name: str
    model_version: str
    source: str
    drivers: tuple[tuple[str, float], ...]
    positive_rate: float
    rows: int


class DisruptionLikelihoodModel:
    """Lazily-fitted logistic regression over the synthetic event history."""

    def __init__(self, seed: int = TRAINING_SEED):
        self._seed = seed
        self._pipeline: Any | None = None
        self._training_rows = 0
        self._positive_rate = 0.0
        self._lock = threading.Lock()
        self._unavailable = False

    # -- training -----------------------------------------------------------

    def _build(self) -> Any:
        # Imported here so a missing scikit-learn degrades to the deterministic
        # scorer instead of breaking import of the whole domain.
        from sklearn.compose import ColumnTransformer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import OneHotEncoder, StandardScaler

        training = build_training_set(self._seed)
        self._training_rows = len(training.rows)
        self._positive_rate = training.positive_rate

        try:
            encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
        except TypeError:  # scikit-learn < 1.2 spelled the argument differently
            encoder = OneHotEncoder(handle_unknown="ignore", sparse=False)

        categorical_index = [FEATURE_ORDER.index(name) for name in CATEGORICAL_FEATURES]
        numeric_index = [FEATURE_ORDER.index(name) for name in NUMERIC_FEATURES]
        pipeline = Pipeline([
            ("prepare", ColumnTransformer([
                ("categorical", encoder, categorical_index),
                ("numeric", StandardScaler(), numeric_index),
            ])),
            ("estimator", LogisticRegression(
                random_state=self._seed, max_iter=1000, solver="lbfgs", C=1.0,
            )),
        ])
        pipeline.fit(_frame(training.features), training.target)
        return pipeline

    @property
    def pipeline(self) -> Any | None:
        if self._pipeline is None and not self._unavailable:
            with self._lock:
                if self._pipeline is None and not self._unavailable:
                    try:
                        self._pipeline = self._build()
                    except Exception:  # noqa: BLE001 - any failure falls back
                        self._unavailable = True
        return self._pipeline

    @property
    def available(self) -> bool:
        return self.pipeline is not None

    # -- explainability -----------------------------------------------------

    def coefficients(self) -> dict[str, float]:
        """Fitted weights keyed by encoded feature name."""
        pipeline = self.pipeline
        if pipeline is None:
            return {}
        names = _readable_names(pipeline)
        weights = pipeline.named_steps["estimator"].coef_[0]
        return {name: float(value) for name, value in zip(names, weights)}

    def _drivers(self, transformed: Any) -> tuple[tuple[str, float], ...]:
        """Per-prediction contributions: standardised value × fitted weight.

        Logistic regression is linear in log-odds, so a feature's contribution
        to *this* prediction is exactly its transformed value times its weight.
        That makes the explanation faithful rather than a post-hoc guess.

        Takes the already-transformed row so a prediction costs one pass
        through the ColumnTransformer rather than two.
        """
        pipeline = self.pipeline
        if pipeline is None:
            return ()
        names = _readable_names(pipeline)
        weights = pipeline.named_steps["estimator"].coef_[0]
        contributions = [
            (name, float(value) * float(weight))
            for name, value, weight in zip(names, transformed, weights)
        ]
        contributions.sort(key=lambda item: abs(item[1]), reverse=True)
        return tuple(contributions[:3])

    # -- inference ----------------------------------------------------------

    def predict(self, features: dict[str, Any]) -> ModelPrediction | None:
        pipeline = self.pipeline
        if pipeline is None:
            return None
        try:
            # Transform once, then score and explain from the same row.
            transformed = pipeline.named_steps["prepare"].transform(_frame([features]))
            probability = float(
                pipeline.named_steps["estimator"].predict_proba(transformed)[0][1]
            )
        except Exception:  # noqa: BLE001 - inference failure falls back too
            return None
        return ModelPrediction(
            likelihood=round(max(0.0, min(100.0, probability * 100.0)), 1),
            model_name=MODEL_NAME,
            model_version=MODEL_VERSION,
            source=SOURCE_ML,
            drivers=self._drivers(transformed[0]),
            positive_rate=self._positive_rate,
            rows=self._training_rows,
        )


def _frame(rows: list[dict[str, Any]]) -> list[list[Any]]:
    """Rows -> column-ordered lists.

    The transformer selects columns positionally, so no DataFrame is needed and
    a single prediction costs one small list rather than a pandas object.
    """
    return [[row[name] for name in FEATURE_ORDER] for row in rows]


def _readable_names(pipeline: Any) -> list[str]:
    """Encoded column names with positional indices resolved back to fields."""
    prepare = pipeline.named_steps["prepare"]
    categories = prepare.named_transformers_["categorical"].categories_[0]
    return (
        [f"asset_type_{value}" for value in categories]
        + list(NUMERIC_FEATURES)
    )


def features_from_state(asset: Any, state: Any, advisory: Any) -> dict[str, Any]:
    """Build the training feature schema from live assessment inputs.

    Every field the model was trained on must be produced here, in the same
    units, or the prediction is meaningless.
    """
    attributes = getattr(asset, "attributes", {}) or {}
    return {
        "asset_type": getattr(asset.asset_type, "value", str(asset.asset_type)),
        "wind_gust_kph": float(state.wind_gust_kph),
        "flood_depth_m": float(state.flood_depth_m),
        "condition_score": float(asset.condition_score),
        "previous_failures": float(attributes.get("previous_failures", asset.open_work_orders)),
        "maintenance_age_days": float(_maintenance_age(asset, advisory)),
        "asset_age_years": float(attributes.get("asset_age_years", 20)),
    }


def _maintenance_age(asset: Any, advisory: Any) -> int:
    """Days between the last inspection and this advisory."""
    inspection = getattr(asset, "last_inspection_date", None)
    issued = getattr(advisory, "issued_at", None)
    if not inspection or not issued:
        return 180
    try:
        inspected = date.fromisoformat(str(inspection)[:10])
        issued_on = datetime.fromisoformat(str(issued).replace("Z", "+00:00")).date()
        return max(0, (issued_on - inspected).days)
    except ValueError:
        return 180


# One process-wide model. Training happens on first use, never per request.
DISRUPTION_MODEL = DisruptionLikelihoodModel()
