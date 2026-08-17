# SGW prototype architecture

## Locked responsibility boundary

```text
fragmented sources -> adapters -> canonical SGW domain -> dependency/risk engines
       -> playbooks and fact packs -> FastAPI -> future React interface
                                      |
                                      +-> OpenAI language rendering
```

- Python owns identity resolution, state, dependency traversal, risk,
  confidence, rankings, recommendations, evidence, and audit transitions.
- The future React application will own visualisation and user interaction. It
  will not reproduce formulas or derive risk in the browser.
- OpenAI receives bounded fact packs and translates facts into concise language.
  It cannot change scores, select response actions, or approve decisions.

## Runtime stack

- Python 3.11+
- FastAPI and Pydantic for the backend contract
- OpenAI Responses API for optional grounded language generation
- pytest and FastAPI TestClient for verification
- deterministic JSON fixtures generated with seed 42
- React, Vite and vinext provide the frontend runtime. Step 6A.1 implements the
  operational map while retaining FastAPI as the analytical source of truth.

The dependency graph currently uses a small domain-specific traversal class.
That keeps redundancy and capacity behavior explicit and avoids adding a graph
framework for a 40-asset prototype. It can be backed by NetworkX later without
changing the domain or API contracts.

### Disruption likelihood runs on two tracks

`LikelihoodEngine` produces two estimates per asset and keeps them apart.

**Operational** is a transparent deterministic scorecard. Five named components
sum to a score, every point is attributable, and this is the *only* likelihood
that reaches systemic risk, tiering, ranking or playbooks.

**Experimental** is a scikit-learn `LogisticRegression` fitted on 2,000 rows of
generated storm history (`sgw_platform.ml`). It is reported alongside the
scorecard and consumed by nothing. `test_ml_track_does_not_move_risk_tier_or_rank`
enforces this by running the whole pipeline with the model disabled and asserting
every operational number is unchanged.

The separation is a design decision, not a migration step. The scorecard's
largest single input is `disruption_baseline`, an authored susceptibility prior.
Training the model on that field would mean learning back a number we wrote
ourselves and presenting the echo as a prediction. So the model is given only
condition, hazard, age and failure-history features and is allowed to disagree.

It does disagree, usefully. On the Hurricane Iris scenario at T-24 the model
rates S31 (condition 40, 30 years old) more likely to fail than S17, while the
platform still ranks S17 first on cascading consequence. That divergence is the
product thesis made visible: disruption probability alone is the wrong
prioritisation signal.

### Divergence is a governance signal, not evidence of error

The shadow model is trained on synthetic history. It is **not** independent
real-world evidence and cannot establish that any operational figure is wrong.
It is not claimed to discover a better truth.

What it can do is disagree, and `GET /api/model/divergence` reports where. Assets
are flagged when their divergence exceeds **mean + 1 standard deviation** of the
network's divergence for that advisory — a distribution-based rule recomputed per
advisory, chosen because a fixed cutoff invites being tuned until it captures
whichever asset a demo wants to discuss. At T-24 that threshold is 20.5 points
(mean 11.1, σ 9.3) and 7 of 40 assets qualify.

S17 diverges by 10.3 points, below the network mean, and is therefore **not** in
the queue. It is not force-fitted in; its comparison stays visible on the asset
page. `test_s17_is_not_force_fitted_into_the_review_queue` pins that.

Findings are worded to the limit of what the model supports:

> S17 shows material divergence between the operational baseline and a shadow
> model using observable asset and hazard features. That divergence identifies the
> susceptibility assumption as a candidate for review.

A wording guard test rejects "does not support", "wrong", "incorrect", "proves"
and "understates" in any finding.

### Promotion criteria

Promotion to the operational track requires real labelled SGW outcomes to measure
calibration against, not a re-weighting. Until then the estimate is labelled
*shadow mode* everywhere it appears, and `GET /api/model` publishes its card:
deployment mode, features, fitted coefficients, training size and seed.

## Repository map

```text
data/sources/              fragmented GIS, maintenance, weather and field data
data/synthetic_sgw.json    generated canonical fixture
src/sgw_platform/adapters/ source-to-canonical federation boundary
src/sgw_platform/models.py canonical domain records
src/sgw_platform/graph.py  dependency traversal and resilience checks
src/sgw_platform/*         risk, confidence, drivers, LLM and playbooks
src/sgw_platform/application.py coherent application-state boundary
src/sgw_platform/api.py    HTTP contract for all future screens
tests/                     domain, scenario, guardrail and API tests
scripts/                   generation, inspection and runtime entry points
frontend/                  React operational interface and Sites configuration
```

The in-memory recommendation and briefing stores are prototype repository
boundaries. SQLite is the intended first persistence upgrade; switching storage
must not change assessment or API semantics.

## Data replacement path

`SGW_DATA_PATH` selects the current canonical fixture. New public or enterprise
sources should normally be introduced as `InfrastructureAdapter`
implementations. This keeps provider schemas and fragmented identifiers outside
the canonical domain.
