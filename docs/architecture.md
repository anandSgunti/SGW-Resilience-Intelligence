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

Likewise, disruption likelihood is currently a transparent deterministic
scorecard, not a falsely labelled trained model. A scikit-learn logistic model
becomes appropriate when labelled disruption outcomes are available; it can be
injected behind `LikelihoodEngine` while preserving the assessment contract.

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
