# SGW Resilience Intelligence Platform

## 1. Overview

SGW Resilience Intelligence is a decision-support prototype for **Southeastern Grid & Water (SGW)**, a **fictional** US utility operating both electricity and water infrastructure. It is built around a **simulated** storm, Hurricane Iris, advancing on SGW's coastal and inland service regions.

The prototype addresses a problem specific to combined electric and water utilities: an electrical failure does not stay electrical. A substation disruption can interrupt the pump station it feeds; once available backup or alternate supply is exhausted, downstream water service and critical facilities can be affected. Assessing assets in isolation misses this entirely, and assessing it without duration misses whether the dependency results in service loss at all.

The operational workflow is **Assess → Respond → Inform**:

| Phase | Question | Screens |
| --- | --- | --- |
| Assess | What needs attention, and why? | Risk Overview, Asset Risk |
| Respond | What are we doing about it, and who owns it? | Response |
| Inform | What changed, and are we responding adequately? | Leadership |

The central thesis:

> **The asset most likely to experience disruption is not necessarily the asset SGW should protect first.**

Prioritisation must combine disruption likelihood with cascading consequence. The prototype demonstrates this by ranking a *less* failure-prone substation above a *more* failure-prone one, because of what depends on it.

**All SGW operational and event data in this repository is synthetic and mock.** SGW does not exist. Hurricane Iris is simulated. No real utility, GIS, SCADA, maintenance or field system is connected. See [§8](#8-synthetic--mock-data).

---

## 2. What the Prototype Demonstrates

### The golden path

A single field revision, propagated through the dependency graph, changes the operational priority of the network.

**T-48 — S17 is a manageable High**

| | |
| --- | --- |
| S17 rank | **#5** |
| Tier | High |
| Estimated restoration | 4h |
| P4 backup endurance | 6h |
| Uncovered service gap | **0h** — backup covers restoration |

**T-24 — a field crew revises the restoration estimate**

| | |
| --- | --- |
| Estimated restoration | **14h** (revised from 4h) |
| P4 backup endurance | 6h (unchanged) |
| Uncovered service gap | **8h** — derived, not authored |
| S17 rank | **#1** |
| Tier | **Critical** |

Nothing about S17's own condition changed. One downstream duration input changed, and the consequence of its failure changed with it. The 8h gap is computed as `restoration − backup`, not stored anywhere.

### The authoritative comparison at T-24

| Asset | Disruption likelihood | Consequence | Systemic risk | Tier | Rank |
| --- | --- | --- | --- | --- | --- |
| **S31** | **83.5%** | 52.2 | 43.6 | High | #2 |
| **S17** | 71.2% | **85.2** | 60.7 | **Critical** | **#1** |

S31 is materially more likely to be disrupted — it is older, in worse condition, and has a failure history. It is still ranked *below* S17.

The reason is the dependency chain `S17 → P4 → W12 → Hospital H3 / Fire Station F2`. A disruption at S17 leaves a hospital and a fire station with 8 hours of water service uncovered by backup. S31 has no comparable downstream exposure. Both terms contribute to the ranking, but it is **the higher cascading consequence that causes S17 to outrank S31 despite its lower likelihood** — and no rule anywhere in the codebase names S17.

---

## 3. Architecture

### Flow

```text
Synthetic source records (fragmented identifiers, varying quality)
        |
        v
Source adapters + canonical SGW identity resolution
        |
        v
Canonical domain model ---- asset state by advisory
        |                   dependency graph
        v                   synthetic historical observations
Analytical layer
  |- disruption likelihood (transparent scorecard) --- AUTHORITATIVE
  |- duration-aware cascading consequence
  |- systemic risk + tier + rank
  |- confidence (evidence quality, held separate from risk)
  |- deterministic response playbooks
  `- shadow ML estimate (experimental) --------------- NOT IN AUTHORITATIVE PATH
        |
        v
FastAPI  ---- optional OpenAI: bounded explanations / leadership brief
        |
        v
React application: Risk Overview | Asset Risk | Response | Leadership
```

> **Analytical code owns decision truth; the LLM owns communication.**
>
> Every number a reviewer sees is computed in Python. The language model receives those numbers as a structured fact pack and turns them into prose. It never computes, ranks, or decides.

The **shadow ML estimate sits outside the authoritative path**. It is not consumed by the authoritative decision path — nothing in risk, tier, ranking or playbooks reads it. It has exactly two downstream uses, both non-operational: side-by-side comparison against the authoritative figure on the Asset Risk screen, and governance/divergence review via `/api/model/divergence`. Neither changes an operational value. See [§4.2](#42-experimental-predictive-ml--shadow-mode).

### Implemented stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.11+ (developed on 3.12.6), FastAPI 0.135.1, Pydantic 2.12.5 |
| Domain | Frozen dataclasses and `StrEnum`, no ORM, no database |
| ML | scikit-learn 1.7.2 — `LogisticRegression` in a `Pipeline` (shadow mode) |
| Frontend | React 19.2.6, vinext 1.0.0-beta.2, Vite 8.0.13, TypeScript 5.9.3 |
| Styling | Tailwind CSS 4.2.1 |
| Mapping | Leaflet 1.9.4 with OpenStreetMap context tiles |
| GenAI | OpenAI Responses API 2.45.0 (optional) |
| Data | Deterministic synthetic JSON, seed 42 |
| Tests | pytest 9.0.3, Node `node --test` rendered-HTML tests |

This is a **React single-page application served by vinext**, not Streamlit, Dash or a notebook.

### Canonical identity

Assets carry a stable `SGW-*` identity; source-system identifiers remain aliases:

```json
"source_ids": { "electric_registry": "SU-1000", "legacy_gis": "GIS/S17" }
```

`SourceRecordIndex` resolves any source identifier to one canonical identity, so `GIS/S17` and `OPS-S17` both resolve to `SGW-S17`. This separation is what would let a real adapter replace the synthetic data without touching the domain model.

### API surface

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/api/state?t=<stage>` | Full ranked state for one advisory |
| GET | `/api/assets/{asset_id}?t=<stage>` | Asset detail, dependency subgraph, evidence |
| GET | `/api/model` | Shadow model card: features, coefficients, provenance |
| GET | `/api/model/divergence?t=<stage>` | Baseline assumption review candidates |
| GET | `/api/playbook-rules` | Versioned rule catalogue, including rules that did not fire |
| POST | `/api/explain` | Grounded operator Q&A |
| POST | `/api/responses/{id}` | Approve / reject / assign / start / complete |
| GET | `/api/responses/{id}/record` | Full governance record for one recommendation |
| POST | `/api/responses/{id}/rationale` | Grounded explanation of one recommendation |
| POST / GET | `/api/verifications` | Record and list field verifications |
| POST | `/api/briefings` | Generate leadership situation brief |
| POST | `/api/briefings/{id}/approve` | Human approval of a brief |

Interactive documentation is served at `/docs` by FastAPI.

---

## 4. Analytical and AI Workflows

### 4.1 Authoritative disruption likelihood

A transparent deterministic scorecard. Five named components sum to a score capped at 98:

| Component | Max | Source |
| --- | --- | --- |
| Baseline susceptibility | 40 | Asset design and reliability characteristics |
| Local storm exposure | 50 | Location-derived wind prediction for the advisory |
| Condition penalty | 16 | Asset condition score |
| Direct hazard stress | 22 | Flood depth, for hazard-sensitive assets only |
| Operational stress | 10 | Current operational status |

Every point is attributable to a named component and displayed as such. **This value is the only likelihood that drives systemic risk, tier, ranking and playbook recommendations.**

It deliberately excludes dependencies, downstream population, restoration duration and backup endurance. Those belong to consequence. Mixing them would make the two terms non-independent and the ranking impossible to explain.

### 4.2 Experimental predictive ML — shadow mode

A genuine scikit-learn model, deliberately kept out of the decision path.

| | |
| --- | --- |
| Estimator | `LogisticRegression(random_state=42, max_iter=1000, solver="lbfgs", C=1.0)` |
| Pipeline | `ColumnTransformer` → `OneHotEncoder` (categorical) + `StandardScaler` (numeric) → estimator |
| Training data | 2,000 deterministic synthetic historical observations, seed 42 |
| Positive rate | 55.8% |
| Provenance | `Logistic Regression` v1.0.0, source `shadow-logistic-regression` |
| Fitting | Once, lazily, thread-locked, cached for the process lifetime |

**Seven features:**

`asset_type` (one-hot) · `wind_gust_kph` · `flood_depth_m` · `condition_score` · `previous_failures` · `maintenance_age_days` · `asset_age_years`

**Explainability.** Logistic regression is linear in log-odds, so a feature's contribution to a specific prediction is exactly its standardised value multiplied by its fitted weight. Per-prediction drivers are computed that way — an exact decomposition, not a post-hoc approximation. Fitted coefficients recovered the generative structure, including the correct negative sign on `condition_score` (a higher score means a healthier asset).

**Status and constraints.**

- Trained **only on synthetic history**, generated from a documented relationship. Not trained on SGW outcomes, which do not exist.
- **Not independent real-world evidence.** Not a validated failure probability.
- **Does not affect authoritative risk, tier, ranking or playbooks.** It is not consumed by the authoritative decision path. It is used only for shadow-model comparison and governance/divergence review.
- Its purpose is to demonstrate a **safe model-introduction and governance workflow**, not to improve prediction.

**Enforcement, not assertion.** `test_ml_track_does_not_move_risk_tier_or_rank` runs the entire pipeline twice — model enabled and disabled — and asserts every `disruption_likelihood`, `risk_score`, `tier` and `rank` is identical across all five advisories. If the shadow estimate ever leaks into the decision path, the build fails.

**Divergence as a governance signal.** Where the two tracks disagree materially, `/api/model/divergence` flags the asset's susceptibility assumption as a candidate for review. The threshold is **mean + 1 standard deviation** of the network's own divergence, recomputed per advisory — a distribution-based rule, chosen because a fixed cutoff invites being tuned until it captures whichever asset a demo wants to discuss. At T-24 that threshold is 20.5 points (mean 11.1, σ 9.3) and 7 of 40 assets qualify. S17 diverges by 10.3 points, below the network mean, and is correctly **not** flagged.

Findings are worded to the limit of what the model supports — divergence identifies an assumption as a review candidate, never as proof that an operational figure is wrong. A guard test rejects the words "wrong", "incorrect", "proves", "understates" and "does not support" in any finding.

**Illustrative shadow estimates at T-24** (produced by the current test suite, *not* validated probabilities):

| Asset | Authoritative likelihood | Shadow ML estimate | Difference |
| --- | --- | --- | --- |
| S31 | 83.5% | 79.9% | 3.6 pts |
| S17 | 71.2% | 60.9% | 10.3 pts |

**Promotion criteria.** Real labelled SGW outage outcomes, used to measure calibration and performance against the scorecard baseline. Until then the model stays in shadow.

### 4.3 Dependency and consequence analytics

```text
Systemic Risk = Disruption Likelihood × Cascading Consequence / 100
```

Confidence is **not** a third multiplier. Evidence quality describes how much to trust an assessment, not how severe it is; folding it into the score would let poor data quietly lower a genuine risk.

Consequence is `base(asset_type) + Σ(exposure × duration_factor × resilience_factor)` across service paths, and incorporates:

- **Downstream service impact** — breadth-first traversal of the dependency graph
- **Population exposure** — residents served, scaled by the capacity share actually lost
- **Critical facilities** — hospitals, fire and police stations, EOCs, dialysis centres
- **Restoration duration** — how long the outage is expected to last
- **Backup endurance** — how long downstream backup actually covers it
- **Redundancy / alternate supply** — alternate feeds attenuate consequence

The population term is normalised against the largest service zone in the network, derived at runtime rather than hardcoded, so no single asset is structurally pinned at the ceiling.

### 4.4 Response intelligence

Recommendations come from a **versioned deterministic playbook catalogue** (rules R1–R5). Rules evaluate structured trigger conditions against assessment output. Nothing is generated by a language model.

Humans hold the authority: **approve, reject, assign, start, complete**. Each transition is validated against an allowed state machine, requires a named actor, requires a reason on rejection, and requires an owner on assignment. Ownership established at assignment carries forward to every subsequent event, so the audit trail can always say who held the work.

`/api/playbook-rules` publishes rules that did **not** fire alongside those that did, so a reviewer can see what was considered and rejected.

The prototype has **no infrastructure control path and no crew dispatch**. Completing an action records an observation; it does not operate anything.

### 4.5 Grounded GenAI

OpenAI is used for exactly two things:

1. **Operator explanation and bounded Q&A** — Asset Risk and Response screens
2. **Leadership situation brief** — drafted, then human-approved before it counts

The model receives a **structured fact pack** built from computed backend output, hashed with SHA-256 so the exact inputs behind any answer can be reproduced.

The LLM **does not**:

- calculate authoritative risk, likelihood, consequence or confidence
- invent dependencies or asset relationships
- create authoritative operational state
- approve, reject or assign actions
- control any infrastructure

**Deterministic fallback.** Without `OPENAI_API_KEY`, `PlatformApplication` selects `TemplateNarrator` instead of `OpenAIResponsesNarrator`. This is an offline narrator that composes the same fact pack into prose deterministically. Assess → Respond → Inform works fully with no API key and no network access; only the phrasing differs.

---

## 5. Screens and User Workflow

| Screen | Question | Contents |
| --- | --- | --- |
| **Risk Overview** | What needs attention? | Advisory timeline, ranked systemic risk, operational map with service zones and hazard areas, headline changes since the previous advisory |
| **Asset Risk** | Why does this asset matter? | Model comparison (authoritative vs shadow), dependency graph with infrastructure / consequence / confidence lenses, per-node evidence, baseline assumption review, grounded Q&A |
| **Response** | What are we doing? | Recommendations with rule provenance and evidence, approve / reject / assign / start / complete, field verification capture, audit history |
| **Leadership** | What changed, and are we responding? | Advisory-to-advisory comparison, largest mover with actual computed movement, mitigation coverage, grounded situation brief with human approval |

Confidence is named per evidence type rather than shown as one number, and an impact path inherits the confidence of its **weakest** link — so a chain of "High" labels can never imply a high-confidence conclusion when one link is unverified.

---

## 6. Running Locally

### Prerequisites

- Python 3.11 or later
- Node.js 20 or later
- No database, message broker or external service is required

### Backend

```bash
pip install -e ".[api,dev,llm]"
```

```bash
python scripts/run_api.py
```

The API starts on `http://127.0.0.1:8000`. Interactive docs: `http://127.0.0.1:8000/docs`.

For auto-reload during development:

```bash
python -m uvicorn sgw_platform.api:create_app --factory --reload --port 8000 --host 127.0.0.1
```

### Frontend

```bash
cd frontend && npm install
```

```bash
cd frontend && npm run dev
```

The application starts on `http://localhost:3000`.

### Regenerating synthetic data

The canonical dataset is committed, so this is optional. It is deterministic — the same seed reproduces the same file:

```bash
python scripts/generate_synthetic_data.py
```

### Environment variables

All are optional. Copy `.env.example` to `.env` to change any of them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Enables OpenAI narration. **Without it the platform runs fully on the deterministic narrator.** |
| `OPENAI_MODEL` | `gpt-5.6-luna` | Model used for narration |
| `SGW_DATA_PATH` | `data/synthetic_sgw.json` | Alternative canonical dataset |
| `SGW_CORS_ORIGINS` | localhost 3000/5173 | Origins permitted to call the API |
| `NEXT_PUBLIC_SGW_API_URL` | `http://127.0.0.1:8000` | Backend URL used by the frontend |

---

## 7. Demo Path

A reviewer can follow the full argument in roughly five minutes.

1. **Risk Overview at T-48.** S17 sits at rank #5, tier High. Note the ranked list and the operational map.
2. **Advance to T-24.** S17 moves to #1 and turns Critical. The headline change names the driver.
3. **Open S17 in Asset Risk.** Authoritative likelihood 71.2%, consequence 85.2. Compare with S31: higher likelihood at 83.5%, lower consequence at 52.2, ranked below.
4. **Inspect the dependency chain** `S17 → P4 → W12 → H3 / F2`. Switch between the infrastructure, consequence and confidence lenses. Note that the impact path inherits its weakest evidence.
5. **Review the model comparison.** Shadow ML estimate 60.9% against the authoritative 71.2%, labelled experimental and excluded from ranking.
6. **Ask a grounded question** in the Q&A panel. The answer cites computed facts and carries a fact-pack hash.
7. **Open Response.** Review a recommendation, its triggering rule and version, and its supporting evidence. Approve and assign it.
8. **Record a field verification** against P4. Confidence rises; risk does not move, because evidence quality and severity are separate.
9. **Open Leadership.** Compare T-48 with T-24, check the largest mover and mitigation coverage.
10. **Generate the situation brief**, edit it, and approve it as a named human.

---

## 8. Synthetic / Mock Data

Every dataset in this repository is generated. Nothing connects to a real system.

| | |
| --- | --- |
| SGW | **Fictional utility.** No real organisation is represented. |
| Hurricane Iris | **Simulated storm** across five advisories: T-72, T-48, T-24, T-12, Landfall. |
| Geospatial data | **Synthetic** coordinates, service-zone polygons and hazard areas. GIS-*like* in shape, not sourced from any GIS. |
| Source fragmentation | **Synthetic.** Differing identifiers and quality across mock providers. |
| Training history | **Synthetic and deterministic**, 2,000 rows, seed 42. |

**Scale:** 40 assets, 31 dependencies, 5 advisories, 200 asset-state records.

**No real SGW GIS, maintenance, SCADA or field system is connected.** There is no live ingestion of any kind.

### What is actually consumed

The canonical dataset `data/synthetic_sgw.json` is the single runtime input. It contains a `source_data` block holding the fragmented mock source records, and that block **is** consumed — `SourceRecordIndex` builds the identity resolution map from it, and `test_foundation.py` exercises it.

`data/sources/*.json` (`gis.json`, `maintenance.json`, `field_ops.json`, `weather_advisories.json`, `field_updates.json`, `dependencies.json`) are **human-readable exports** written alongside the canonical dataset by the generator. They exist so a reviewer can inspect the pre-federation records. **They are not read by any code path at runtime.** They are not, and are not claimed to be, live ingestion sources.

### Deliberate constraint on training data

No SGW asset identifier appears anywhere in the training data generator. A test (`test_training_data_encodes_no_demo_asset`) asserts the string `SGW-` is absent from the file. Where the shadow model ranks S31 above S17, that reflects their feature values, not a taught answer.

---

## 9. Assumptions

- **Electricity-water dependency is the material coupling.** Substations power pump stations; pump stations serve water zones; critical facilities sit inside those zones.
- **Source systems remain authoritative for their own records.** The platform federates and derives; it does not become the system of record.
- **Identifiers differ across source systems.** Canonical identity must be resolved, not assumed.
- **Data quality varies by source and by asset**, and that variance must be surfaced rather than averaged away.
- **Production-grade labels are not available.** No validated disruption outcomes exist for SGW, which is precisely why the ML model runs in shadow.
- **Consequence depends on duration, not only topology.** Restoration time, backup endurance and redundancy determine whether a dependency actually results in service loss.
- **This is decision support, not hard real-time control.** Humans retain operational authority.
- Thresholds, tier boundaries and scoring weights are **demonstration assumptions**, not industry standards.

---

## 10. Limitations

- **All data is synthetic.** No conclusion here describes real infrastructure.
- **No production predictive-accuracy claim** is made for any figure in this prototype.
- **No live SGW, GIS, SCADA, weather or field-system integration.** No streaming telemetry.
- **Simplified dependency network** — 40 assets, one-hop electricity-to-water propagation, simplified redundancy modelling.
- **One simulated hazard scenario** — a single hurricane with wind and flood. No compound-hazard, seismic or multi-event modelling.
- **No authentication, authorisation or RBAC.** Actors are named strings, not verified identities. Suitable for local review only.
- **Response state is held in memory.** Restarting the backend resets recommendation decisions. This is intentional for a prototype.
- **The shadow ML model requires real historical outcomes before any promotion decision** could responsibly be made. Its current estimates are not validated probabilities.
- **OpenAI output requires production evaluation and governance** — systematic quality measurement, monitoring, red-teaming and drift detection — none of which is implemented here.
- Map tiles are third-party context only and are not part of any calculation.

---

## 11. Human-in-the-Loop and Governance

| Property | Implementation |
| --- | --- |
| Risk computation is automatic | Deterministic Python, reproducible from the same inputs |
| Evidence is inspectable | Every score decomposes into named, displayed components |
| Recommendations are rule-based | Versioned playbook catalogue, no generative content |
| Human approval is required | Approve / reject / assign / start / complete, all attributed |
| Audit history is retained | Every transition records status, timestamp, actor, owner and reason |
| Risk and confidence stay separate | Confidence never multiplies into the risk score |
| No infrastructure-control write path | Nothing in the system can operate equipment or dispatch crews |
| Shadow ML cannot leak into the authoritative decision path | Enforced by test, not by convention. Its only downstream use is governance/divergence review, which changes no operational value |
| LLM output is display-only | Fact packs are hashed; the model cannot alter operational state |
| Rejected options are visible | Rules that did not fire are published alongside those that did |

---

## 12. Failure and Graceful-Degradation Behaviour

| Failure | Behaviour |
| --- | --- |
| No `OPENAI_API_KEY` | `TemplateNarrator` is selected automatically. Full deterministic narration, no network calls. |
| OpenAI request fails or the SDK is missing | Assess → Respond is unaffected. Analytical output never depends on the narration layer. |
| scikit-learn unavailable or model fitting fails | The shadow track is silently omitted and the divergence review returns empty rather than inventing findings; the authoritative scorecard is unchanged. The UI states "Model unavailable" rather than showing an empty value. |
| OpenStreetMap tiles fail to load | SGW markers, service zones, hazard overlays and all calculations remain fully usable. Tiles are context only. |
| One advisory in the leadership trajectory fails | That stage degrades locally. Remaining stages still render, because the trajectory fetch settles all requests rather than rejecting on the first failure. |

---

## 13. Testing

Run from the repository root.

**Backend**

```bash
python -m pytest
```

**Frontend** — typecheck, lint, production build and rendered-HTML tests:

```bash
cd frontend && npm test
```

### Current results

Both suites were run immediately before this document was finalised.

| Suite | Result |
| --- | --- |
| Backend (`pytest`) | **119 passed** |
| Frontend (`npm test`) | **21 passed** |
| TypeScript (`tsc --noEmit`) | Clean |
| ESLint | 0 errors (3 pre-existing `react-hooks/exhaustive-deps` warnings) |
| Production build | Clean |

### Coverage by area

| File | Tests | Covers |
| --- | --- | --- |
| `test_ml_likelihood.py` | 19 | Logistic-regression fitting, dataset determinism, bounded predictions, feature-schema agreement, shadow isolation from ranking, divergence rule, wording guard, graceful degradation |
| `test_api.py` | 18 | Endpoint contracts, ranked-state shape, playbook catalogue including non-firing rules |
| `test_transparency.py` | 12 | Score decomposition, evidence exposure, rule provenance |
| `test_verification.py` | 11 | Field verification, reassessment, owner propagation across the lifecycle |
| `test_foundation.py` | 9 | Canonical identity, source federation, alias resolution |
| `test_systemic_risk.py` | 7 | Likelihood × consequence, tier boundaries, ranking order |
| `test_playbooks.py` | 7 | Rule triggering, state-machine transitions, invalid transitions |
| `test_likelihood.py` | 7 | Scorecard components, caps, band assignment |
| `test_consequence.py` | 6 | Duration awareness, backup endurance, redundancy attenuation |
| `test_frontend_contract.py` | 5 | Cross-boundary contract between API output and frontend literals |
| `test_drivers.py` | 5 | Change attribution between advisories |
| `test_explanations.py` | 4 | Fact-pack construction, hashing, OpenAI fallback, no-storage policy |
| `test_confidence.py` | 4 | Confidence separation from risk |
| `test_acceptance.py` | 3 | End-to-end acceptance checks |
| `test_golden_path.py` | 2 | T-48 → T-24 S17 transition; `Landfall` API stage token |

Two regressions are worth calling out specifically. The **golden-path test** verifies the full T-48 → T-24 S17 transition end to end. The **Landfall identifier test** pins the API stage token: the UI may display `T-0`, but the backend publishes `Landfall` and must never be requested as `?t=T-0` — a mismatch that previously blanked the leadership trajectory.

---

## 14. Future Enhancements

- Real SGW system integrations replacing the synthetic adapters
- Outcome-labelled historical data enabling calibration, validation and a decision on promoting the shadow model
- Streaming telemetry and anomaly detection
- Crew, depot and travel-time optimisation once resource data exists
- Computer vision for damage assessment once imagery exists
- Expanded hazard types, compound events and wider geographies
- Enterprise SSO, RBAC, observability and production LLM evaluation
