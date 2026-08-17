"""Deterministic synthetic training history for the disruption-likelihood model.

The rows here are *historical asset-event observations*: one storm exposure of
one asset, plus whether it was disrupted. They are generated from a documented
structural relationship with controlled noise, so the model has something real
to learn while the data stays reproducible.

Two deliberate constraints:

* No demo asset is encoded. Nothing references S17, S31, P4 or any SGW id, and
  the generator never sees the live network. If the model happens to rank S31
  above S17 it is because their features differ, not because it was taught to.
* The coefficients below are a *generative* relationship, not fitted targets.
  They describe how the synthetic world behaves; the model has to recover them
  from noisy labels, and will not recover them exactly.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any

TRAINING_SEED = 42
TRAINING_ROWS = 2_000

# Feature order is the contract between training and inference. Changing it
# without retraining silently mis-maps every column.
NUMERIC_FEATURES = [
    "wind_gust_kph",
    "flood_depth_m",
    "condition_score",
    "previous_failures",
    "maintenance_age_days",
    "asset_age_years",
]
CATEGORICAL_FEATURES = ["asset_type"]
FEATURE_ORDER = CATEGORICAL_FEATURES + NUMERIC_FEATURES
TARGET = "disrupted"

ASSET_TYPES = [
    "substation",
    "pump_station",
    "water_zone",
    "hospital",
    "fire_station",
    "emergency_operations_centre",
    "dialysis_centre",
    "police_station",
]

# --- the synthetic world's true relationship -------------------------------
# log-odds of disruption = intercept + Σ(weight × standardised driver)
_INTERCEPT = -2.35
_WEIGHTS = {
    "wind": 2.60,          # dominant hazard for above-ground plant
    "flood": 1.45,         # matters most where an asset sits low
    "condition": 1.30,     # poor condition compounds every other stressor
    "failures": 0.85,      # a history of failure predicts more failure
    "maintenance": 0.55,   # overdue inspection widens the unknown
    "age": 0.45,
}
# Built plant is more exposed than a service polygon; facilities are hardened.
_TYPE_EFFECT = {
    "substation": 0.55,
    "pump_station": 0.40,
    "water_zone": -0.65,
    "hospital": -0.30,
    "fire_station": -0.25,
    "emergency_operations_centre": -0.40,
    "dialysis_centre": -0.20,
    "police_station": -0.25,
}
# Label noise: some assets survive a battering, some fail in a breeze. Without
# this the problem is separable and the model learns an unrealistically sharp
# boundary.
_LABEL_NOISE = 0.06


@dataclass(frozen=True)
class TrainingSet:
    rows: list[dict[str, Any]] = field(default_factory=list)

    @property
    def features(self) -> list[dict[str, Any]]:
        return [{key: row[key] for key in FEATURE_ORDER} for row in self.rows]

    @property
    def target(self) -> list[int]:
        return [int(row[TARGET]) for row in self.rows]

    @property
    def positive_rate(self) -> float:
        return sum(self.target) / len(self.target) if self.rows else 0.0


def _sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def build_training_set(seed: int = TRAINING_SEED, rows: int = TRAINING_ROWS) -> TrainingSet:
    """Generate the historical observation table. Same seed, same table."""
    rng = random.Random(seed)
    records: list[dict[str, Any]] = []

    for _ in range(rows):
        asset_type = rng.choice(ASSET_TYPES)
        wind_gust_kph = round(rng.uniform(30.0, 165.0), 1)
        # Most events are dry; flooding is a tail, so a plain uniform draw would
        # over-represent it.
        flood_depth_m = round(max(0.0, rng.gauss(0.28, 0.42)), 2)
        condition_score = rng.randint(35, 98)
        previous_failures = min(6, int(rng.expovariate(1 / 1.1)))
        maintenance_age_days = rng.randint(5, 900)
        asset_age_years = rng.randint(1, 60)

        # Standardise each driver to roughly 0..1 before weighting so the
        # coefficients stay comparable to each other.
        drivers = (
            _WEIGHTS["wind"] * ((wind_gust_kph - 30.0) / 135.0)
            + _WEIGHTS["flood"] * min(1.0, flood_depth_m / 1.5)
            + _WEIGHTS["condition"] * ((100 - condition_score) / 65.0)
            + _WEIGHTS["failures"] * (previous_failures / 6.0)
            + _WEIGHTS["maintenance"] * (maintenance_age_days / 900.0)
            + _WEIGHTS["age"] * (asset_age_years / 60.0)
        )
        probability = _sigmoid(_INTERCEPT + drivers + _TYPE_EFFECT[asset_type])
        if rng.random() < _LABEL_NOISE:
            probability = 1.0 - probability
        disrupted = int(rng.random() < probability)

        records.append({
            "asset_type": asset_type,
            "wind_gust_kph": wind_gust_kph,
            "flood_depth_m": flood_depth_m,
            "condition_score": condition_score,
            "previous_failures": previous_failures,
            "maintenance_age_days": maintenance_age_days,
            "asset_age_years": asset_age_years,
            TARGET: disrupted,
        })

    return TrainingSet(records)
