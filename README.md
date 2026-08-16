# SGW Resilience Intelligence Platform

A synthetic-first, end-to-end resilience intelligence prototype for fictional
Southeastern Grid & Water. Hurricane Iris drives a deterministic network of
electric, water and critical-facility dependencies through **Assess → Respond →
Inform**. The backend owns identity, advisory state, graph consequences, risk,
confidence, recommendations and audit history; React renders that backend truth.

The submission includes four integrated screens: Risk Overview, Asset Risk,
Response and Leadership. The locked demo transition is reproducible from seed 42:
S17 moves from High at rank #5 at T-48 to Critical at rank #1 at T-24 when its
restoration estimate changes from 4h to 14h against P4's 6h backup.

The revised 6A.1 geography uses Leaflet with an optional OpenStreetMap context
layer in a fictional US Atlantic coastal-to-inland territory. Coastal,
inland-flood and inland-resilient zones, SGW assets, dependencies
and hazard overlays are synthetic and application-owned, so analytical behavior
continues if external map tiles are unavailable.

Step 6A.3 adds the advisory-transition strip, top-movers drawer and grounded
asset explanation. All displayed transitions come from backend change drivers;
the interface does not recalculate or invent movement.

Step 6A.4 completes Screen 1 with the Southeastern Grid & Water event header,
four backend-owned operational KPIs, and source-freshness context.

Step 6B.1 starts Screen 2 with a generic interactive dependency graph. The
Infrastructure, Consequence and Confidence lenses alter visual emphasis over
one backend-owned topology; node and edge evidence comes from the asset-detail
contract, including verification, provenance and current advisory state.

Step 6B.2 completes the selected-node detail panel with type-aware operating
facts, upstream and downstream evidence, confidence gaps, recommended-response
previews, and an explicit verification handoff. The handoff never approves or
executes work; those human decisions remain owned by the future Respond screen.

Step 6B.3 adds compact grounded questions for the currently selected graph
node. Suggested and free-text questions use the existing explanation endpoint;
answers display their fact-pack identity and supporting facts. The offline
renderer now answers change, uncertainty, and rank-comparison questions from
the same bounded evidence supplied to the optional OpenAI narrator.

Step 6C.1 starts the Response Board with a backend-owned recommendation queue,
priority filters, evidence and ownership detail, and attributed approve/reject
decisions. Each decision uses the validated response lifecycle and returns its
audit event to the interface; no recommendation can silently become field work.

Step 6C.2 completes the controlled operational lifecycle in the same board:
approved work requires an assigned owner, assigned work requires an attributed
start, and completion requires an operator and completion note. The backend
continues to enforce transition order while the UI refreshes status, ownership,
counts and the immutable audit trail after every decision.

Step 6C.3 closes the loop between field work and intelligence. Completing a
verification action now requires the observed result, which updates the asset's
operational state, triggers reassessment, and moves risk and confidence for
every affected asset. The before/after audit trail is preserved. See
[Field verification loop](#field-verification-loop).

Step 6C.4 makes every recommendation explain itself. Each one publishes a
trigger, an impact, and a versioned rule reference, so an approval can be
audited without reading the rule engine. See
[Playbook transparency](#playbook-transparency).

## Reviewer quick start

Prerequisites: Python 3.11+ and Node.js 22.13+. Run all setup commands from the
repository root. No OpenAI key is required.

```powershell
python -m pip install -e ".[api,dev]"
npm --prefix frontend ci
```

The seed-42 dataset is already included. Regeneration is optional and produces
the same canonical fixture:

```powershell
python scripts/generate_synthetic_data.py
```

Start the backend in terminal 1:

```powershell
python scripts/run_api.py
```

Start the frontend in terminal 2, also from the repository root:

```powershell
npm --prefix frontend run dev
```

Open `http://localhost:3000`. Hurricane Iris and T-24 load by default. The four
routes are `/`, `/asset-risk`, `/respond`, and `/leadership`; navigation preserves
the selected advisory and asset.

Optional OpenAI narration: copy `.env.example` to `.env` and set
`OPENAI_API_KEY`. Without it, a deterministic offline narrator is used. If the
LLM is unavailable, rankings, dependencies, recommendations and human response
workflows remain functional.

Run the reviewer acceptance gate:

```powershell
python scripts/verify_clean_run.py
python -m pytest -q
npm --prefix frontend test
```

`data/synthetic_sgw.json` is deterministic (seed `42`). The domain imports raw
source records through an adapter, so a future public-data adapter can replace
the synthetic one without changing the graph or assessment models.

## Design rules

- Canonical `SGW-*` identifiers are stable; provider/source IDs stay as aliases.
- `Asset` is static identity and capability. `AssetState` changes for an advisory.
- Relationships describe topology only. `Assessment` is derived, never authored.
- The engine accepts any compatible asset graph; scenario clusters live in data,
  not as special cases in the calculation code.

## Risk engine progress

Step 5F.1 implements disruption likelihood as an explainable, deterministic
calculation. It combines baseline susceptibility, local storm exposure, asset
condition, direct hazard stress, and current operational stress. It deliberately
does not use dependencies, restoration duration, backup, population, or critical
facilities; those belong to the consequence layer in Step 5F.2.

Step 5F.2 implements duration-aware consequence. It derives downstream service
paths, effective population after partial capacity, critical facilities,
restoration-minus-backup gaps, and alternate-feed resilience. Assets without a
modeled downstream path retain a small asset-type base consequence.

Step 5F.3 combines likelihood and consequence using a transparent product,
applies deterministic prototype tiers, and ranks each advisory by systemic risk,
then consequence, then likelihood. Timeline assessments retain previous rank and
rank movement. Confidence is intentionally excluded from the risk calculation.

Step 5F.4 scores evidence confidence independently from risk using completeness,
freshness, verification, and source agreement. It returns High, Medium, or Low,
compact reasons, an insufficient-data flag, and verification actions. P4 field
verification moves S17 confidence from Medium to High without reducing risk.

Step 5F.5 emits structured current drivers and deterministic change drivers for
each advisory comparison. These include restoration, backup gap, flood exposure,
consequence, risk, tier, rank, confidence, and verification changes, plus one
primary change explanation suitable for UI banners and grounded fact packs.

Step 5F.6 adds an optional grounded narrative layer using the OpenAI Responses
API. The LLM receives only a deterministic fact pack, cannot change scores or
recommend actions, runs with response storage disabled, and is rejected if it
introduces unsupported numeric claims. `gpt-5.6-luna` is the configurable default.

```powershell
pip install -e ".[llm]"
$env:OPENAI_API_KEY="your-key"
python scripts/generate_explanation.py --asset SGW-S17 --advisory ADV-T24
```

For an offline check, use `python scripts/generate_explanation.py --offline`.

Step 5G adds a deterministic response/playbook engine. Five transparent rules
recommend temporary generation, evidence verification, critical-facility
escalation, flood protection, or coordinator escalation from derived assessment
facts. Recommendations carry stable IDs, evidence, priority, and default owners.
They never execute themselves: people approve, reject, assign, start, and
complete work through a validated lifecycle with an immutable audit history.

```powershell
python scripts/inspect_playbooks.py
```

Step 5H exposes one coherent application state through a thin FastAPI backend.
The frontend does not recalculate risk or infer dependency effects. It consumes
the ranked state, asset drill-down, grounded explanations, response decisions,
and versioned leadership briefings produced here. In-memory stores are explicit
prototype boundaries that can later be replaced with database repositories.

```powershell
pip install -e ".[api]"
python scripts/run_api.py
```

The interactive API contract is available at `http://127.0.0.1:8000/docs`.
Use `python scripts/inspect_api.py` for a no-server contract smoke check.

## Implementation structure

Step 5I locks the practical runtime and repository boundaries without building
the frontend prematurely. Copy `.env.example` to `.env` only for local values;
never commit an API key. `SGW_DATA_PATH` can point the API at a replacement
canonical dataset, and `SGW_CORS_ORIGINS` controls the future browser client.

Install the complete backend development environment with:

```powershell
pip install -e ".[api,llm,dev]"
```

See `docs/architecture.md` for component ownership, technology trade-offs and
the real-data replacement path. See `docs/api.md` for the frontend-facing
contract.

## Backend acceptance gate

Step 5J converts the build checkpoints into an executable release gate:

```powershell
python scripts/verify_milestone.py
```

It proves the seed-42 data is reproducible and verifies identity federation,
dependency traversal, risk transitions, S17/S31 behavior, P11 flood response,
playbooks, human audit history, API routes, the field verification loop,
playbook transparency, the governance record, and offline explanation behavior.
See `docs/acceptance.md` for the full checkpoint map.

## Field verification loop

Step 6C.3 closes the operational loop. Playbook rules carry an `action_class`,
so a verification action is identifiable without the client knowing rule ids.
Completing one with a recorded result rewrites the observed `AssetState` and
re-runs the existing engines; no risk formula changed to support this.

```
uncertainty identified -> verification action -> field result recorded
  -> operational state updated -> risk and confidence recomputed -> screens refresh
```

`src/sgw_platform/verification.py` owns the single translation step from a field
outcome to observed state. It contains no asset ids and no risk arithmetic.

| Outcome | Observed state | Effect at T-24 |
| --- | --- | --- |
| `verified_operational` | verified, generator operational, confirmed endurance | S17 confidence 82.8 → 97.8 (Medium → High); risk holds at 68.4 Critical |
| `verified_degraded` | verified, degraded, endurance halved unless confirmed | uncovered gap widens in proportion to the confirmed endurance |
| `unavailable` | verified, generator unavailable, 0h backup | P4 39.8 → 52.9 (Medium → High, rank #4 → #2); S17 gap 8h → 14h |

A confirmed observation carries forward to every later advisory, never backward.
Each record keeps its before/after snapshots and one operator-readable sentence:

> At T-24, SGW-P4 readiness was unverified (reported operational, 6h backup).
> At 13:42, Field Operations confirmed operational readiness: Generator operational.

Record a result either by completing a verification action
(`POST /api/responses/{id}` with a `result` body) or directly through
`POST /api/verifications`. Both return the reassessment they triggered.
`GET /api/verifications` and the `verifications` key on `/api/state` expose the log.

Two behaviours worth knowing. Outcome `unavailable` does not raise S17's risk
score, because its consequence is already at the 96-point cap — the widened
8h → 14h gap is visible in the driver, not the score. And no new playbook rule
fires on that outcome; R1, R3 and R5 already cover the asset. Adding a rule for
confirmed backup shortfall on a High-tier asset would be a real gap to close,
but it is a rule change, not part of this loop.

## Playbook transparency

Step 6C.4 publishes why each recommendation exists in three compact layers,
without exposing a single rule predicate:

```
Trigger   S17 restoration 14h > P4 backup 6h
Impact    8h uncovered · W12 · F2 · H3
Rule      Playbook R1 · Critical backup-gap response      [View rule]
          R1 v1.2 · IRIS-T24
```

`View rule` reveals the published summary and configured limits only:

> Triggered when a Critical asset creates a downstream backup gap above the
> configured threshold.
> Risk tier: Critical · Minimum uncovered gap: 4 hours · Requires: an
> identified limiting downstream service

`src/sgw_platform/rules.py` is the single rule catalogue: identity, version,
operator-language summary and configured thresholds. The matching predicates
stay in `PlaybookEngine`. **Bump a rule's `version` whenever its logic changes** —
the version travels into every recommendation it produces and therefore into
the audit record. `GET /api/playbook-rules` publishes the whole catalogue,
including rules that did not fire.

`assessment_source` (`IRIS-T24`) traces which advisory produced the action.

### Audit record

`GET /api/responses/{id}/record` answers all five governance questions in one
object: what was recommended, why (trigger and impact), which rule and version
fired, which advisory and state were used, and who decided what. If the action
was a field verification, the record it triggered is linked too.

### The narration boundary

`POST /api/responses/{id}/rationale` lets a model rewrite one rationale into
readable language. It cannot create, modify, or approve the action. That is
enforced structurally, not by prompt alone:

- the narrator receives a read-only fact pack containing no lifecycle verbs;
- no code path turns narrator output into a `Recommendation`;
- `explain_recommendation` digests the stored record before and after the call
  and raises if it differs;
- the authored rationale is always returned alongside the narrated one.

`tests/test_transparency.py` proves this with a hostile narrator that returns
"APPROVED by the model… cancel this action… raise the threshold to 40 hours".
The action stays `recommended`, unmodified, and no new recommendation appears.

## Frontend progress

Four screens, all reading backend-owned state. No screen recalculates risk,
consequence or confidence.

| Screen | Route | Steps |
| --- | --- | --- |
| Risk Overview | `/` | 6A.1–6A.4 |
| Asset Risk | `/asset-risk` | 6B.1–6B.3 |
| Response Board | `/respond` | 6C.1–6C.4 |
| Leadership | `/leadership` | 6D.1–6D.4 |

Steps 6A.1 and 6A.2 implement the operational risk map and priority rail:
advisory timeline, backend-owned hurricane footprint, infrastructure layers,
hover details, selected dependency preview, biggest-change focus, Priority and
Change sorting, asset filters, and expandable likelihood-versus-consequence
evidence for every ranked asset.

Step 6D gives leadership a preparedness view rather than a workflow view:
headline risk KPIs (6D.1), response readiness and mitigation coverage over the
Critical set (6D.2), a grounded executive brief that a named human drafts,
regenerates and approves (6D.3), and an event trajectory across every advisory
with structured before/after deltas (6D.4).

Step 6E preserves workflow context across all four screens. `WorkflowNav`
carries the advisory, asset and filter selection between routes, and
`IncidentContext` centralises advisory refresh so one fetch serves every panel.

### Advisory stage tokens

The backend publishes five stages: `T-72`, `T-48`, `T-24`, `T-12` and
`Landfall`. `Landfall` is the canonical token for the final advisory; screens
may display it as `T-0` but must send `Landfall`. `tests/test_frontend_contract.py`
fails the build if any screen hard-codes a stage the API does not resolve.

Run the backend first, then the frontend:

```powershell
$env:PYTHONPATH="src"
python scripts/run_api.py

cd frontend
npm ci
npm run dev
```

Open `http://localhost:3000`. See `frontend/README.md` for the exact scope.

## Quality gates

Both suites must be green before a step is considered complete.

```powershell
python -m pytest
cd frontend; npm test
```

`npm test` runs `tsc --noEmit`, then `eslint`, then the build, then the
rendered-HTML and source-contract assertions. Type and lint failures break the
build rather than accumulating silently.

`python -m pytest` needs no `--basetemp` flag: `pyproject.toml` points pytest
at a git-ignored `.pytest_tmp/` because the system temp directory denies
`scandir` on some Windows profiles. Scratch from passing runs is discarded.
