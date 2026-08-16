# SGW Resilience Command frontend

Three screens for Hurricane Iris: risk overview (`/`), asset risk
(`/asset-risk`) and the response board (`/respond`). Every screen consumes the
FastAPI contracts and contains no risk, consequence, confidence, ranking,
playbook or reassessment formulas.

## Run locally

Start the backend from the repository root:

```powershell
$env:PYTHONPATH="src"
python scripts/run_api.py
```

Then start the interface from this directory:

```powershell
npm ci
npm run dev
```

Open `http://localhost:3000`. The default backend address is
`http://127.0.0.1:8000`; override it with `NEXT_PUBLIC_SGW_API_URL` when needed.

## Implemented through 6A.4

- shared T-72 through landfall advisory timeline
- backend-supplied hurricane track and impact footprint
- electric, water, critical-facility and service-zone layers
- hover risk details and keyboard-focus parity
- selected-asset halo and generic dependency preview
- S17 → P4 → W12 cascade visibility with critical facilities
- biggest-change focus mode
- responsive map, compact legends, priority context and movement panel
- Priority and Change decision-rail sort modes
- All, Critical, High, Water and Electric quick filters
- compact rank, identity, type, tier, movement and systemic-risk rows
- expanded likelihood, consequence, confidence and top-driver evidence
- split likelihood-versus-consequence bars that expose different risk profiles
- coordinated rail, map, dependency preview and bottom-strip selection
- Leaflet geographic interaction with an OpenStreetMap context layer
- explicit coastal, inland-flood and inland-resilient operating zones
- application-owned service, dependency, storm, wind and flood overlays
- tile-failure fallback that preserves all SGW analytical interactions
- material-change strip comparing the selected asset with the prior advisory
- rank, tier, restoration and backup-gap transitions from backend change drivers
- top-movers drawer coordinated with map and rail selection
- grounded Why-this-asset explanation using the locked backend fact pack
- collapsed baseline/no-material-change state
- lean Southeastern Grid & Water event header with active advisory context
- backend-owned Critical, High, residents-exposed and open-action KPIs
- compact Weather, Field Ops and Maintenance freshness indicator

## Implemented in 6B.1

- generic `/asset-risk?asset=SGW-*\u0026t=T-*` route linked from Screen 1
- graph-first dependency view with deterministic topology layout
- Infrastructure, Consequence and Confidence lenses over the same graph
- validated, service-consequence, inferred and resilience-gap edge semantics
- compact node and edge evidence on hover or keyboard focus
- node selection that updates a type-aware evidence panel without replacing the graph
- authored S17 cascade, confidence uncertainty and alternate-feed cases

## Implemented in 6B.2

- full selected-node panel that updates directly from graph selection
- type-aware operating and consequence facts for every canonical asset type
- incoming and outgoing relationship evidence with confidence status
- explicit confidence reasons and material verification gaps
- verification-action handoff that never auto-approves operational work
- backend-owned recommended-response previews for the relevant asset or target

## Implemented in 6B.3

- suggested questions for risk, ranking, advisory change and uncertainty
- free-text questions scoped to the currently selected graph node
- grounded answers from the backend explanation contract
- supporting facts, model identity and fact-pack trace identifier
- loading and failure states that preserve the rest of the analytical workflow

## Implemented in 6C.1

- generic `/respond?t=T-*&asset=SGW-*` route linked from Assess screens
- backend-owned recommendation queue with Critical and High filters
- selected-action evidence, target and suggested-owner detail
- explicit approve/reject decisions with required operator attribution
- mandatory rejection reason and visible API conflict/error handling
- refreshed status counts and immutable audit events after each decision

## Implemented in 6C.2

- visible recommended-to-completed lifecycle path
- approved-action assignment with required owner and operator
- attributed start transition for assigned operational work
- completion transition with a required operational note
- backend conflict messages for invalid or stale transitions
- owner, actor, timestamp and notes retained in the visible audit trail

## Implemented in 6C.3

- verification actions tagged from `action_class`, never from a hardcoded rule id
- completing one requires an observed outcome: operational, degraded or unavailable
- optional confirmed backup endurance replaces the reported value
- the result rides the existing `POST /api/responses/{id}` call as a `result` body
- reassessment panel showing every before/after movement the backend recalculated
- field verification log with the preserved before/after narrative per record
- Field-verified count in the board header, refreshed with the queue
- outcome is mandatory before completion; nothing auto-approves or self-executes

### What the loop does

Screen 2 surfaces an unverified readiness gap and hands off to this board. The
recommendation is already in the queue. When Field Operations completes it with
a result, the backend rewrites the observed state, reassesses, and this screen
re-reads the outcome:

| Recorded outcome | What the backend returns |
| --- | --- |
| Operational | evidence confidence rises Medium → High; risk score unchanged |
| Unavailable | verified asset gains consequence and can change tier and rank; the dependent asset's uncovered gap widens |

Every number in the reassessment panel is read from the API response. The
client formats it and nothing else.

## Implemented in 6C.4

- three compact evidence layers on every recommendation: Trigger, Impact, Rule
- queue cards lead with the trigger and carry the impact and rule version
- `View rule` reveals the published summary and configured limits, never a predicate
- rule version and assessment source shown as explicit provenance
- `Explain in plain language` calls the narrator and labels the result display-only
- narrated text always sits beside the authored rationale and the live status

Screen 3 is complete with this step.

### What the client is not allowed to do

Every layer is read straight from the API. The client never assembles a trigger,
never evaluates a threshold, and never writes narrated text back into a
decision. Both are asserted in the test suite.

## Implemented in 6D — Leadership view (`/leadership`)

- 6D.1 headline KPIs: Critical, High, residents exposed, mitigation coverage
- 6D.2 response readiness over the Critical set, with deep links into `/respond`
- 6D.3 grounded executive brief: draft, regenerate, and named-human approval
- 6D.4 event trajectory across every advisory, with before/after deltas

### Advisory stage tokens

The backend publishes `T-72`, `T-48`, `T-24`, `T-12` and `Landfall`. The final
advisory's canonical token is `Landfall`; a screen may label it `T-0` but must
send `Landfall`. The trajectory strip loads stages with `Promise.allSettled`, so
one unreachable advisory blanks a single tile instead of the whole strip.

## Implemented in 6E — Workflow continuity

- `WorkflowNav` carries advisory, asset and filter selection across all routes
- `IncidentContext` centralises advisory refresh so one fetch serves every panel
- advisory and asset selection are seeded from the URL during render, so the
  server and client agree and no effect writes that state back on mount

## Testing

```powershell
npm test
```

This runs four gates in order and fails on the first one that breaks:

1. `tsc --noEmit` — currently clean
2. `eslint` — currently 0 errors, 3 warnings (capped at 5 via `--max-warnings`)
3. `vinext build`
4. `node --test tests/rendered-html.test.mjs` — 20 tests

Use `npm run test:render` to skip the type and lint gates while iterating.

### What this suite cannot catch

The assertions here are rendered-HTML and source-string checks. Server-side
rendering never runs the client effects that issue requests, so this suite
cannot detect a value the client sends that the backend rejects — that is how
the 6D.4 `T-0` stage bug shipped. Cross-boundary contract checks therefore live
in the backend suite, in `tests/test_frontend_contract.py`, which reads these
sources and exercises the literals against a running API.
