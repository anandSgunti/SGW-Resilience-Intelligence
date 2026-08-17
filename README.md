# SGW Resilience Intelligence Platform

SGW Resilience Intelligence is a synthetic-first decision-support prototype for fictional Southeastern Grid & Water, a US electricity and water utility responding to Hurricane Iris. It combines federated operational data, disruption-likelihood modelling, dependency analysis, duration-aware consequence assessment, deterministic response playbooks, and grounded OpenAI narration.

**The asset most likely to be disrupted is not necessarily the asset SGW should protect first.** The operational workflow is **Assess -> Respond -> Inform**. Python owns analytical truth, OpenAI owns communication, and authorised humans retain operational authority.

## Demo scenario

```text
Hurricane Iris approaches SGW's coastal and inland regions.

T-48: S17 restoration = 4h; P4 backup = 6h; S17 is High, rank #5.
T-24: S17 restoration = 14h; P4 backup remains 6h; uncovered duration = 8h.

S17 becomes Critical and moves #5 -> #1,
despite S31 having a higher disruption likelihood.
```

The systemic dependency chain is `S17 -> P4 -> W12 -> Hospital H3 / Fire Station F2`. Its downstream consequences make S17 the priority, rather than a hardcoded asset rule. Other authored clusters demonstrate alternate-feed redundancy and direct inland-flood exposure.

## Architecture

```text
Synthetic source data
        |
        v
Adapters + canonical SGW model ---- hazard / field state
        |                           dependency graph
        v                           synthetic historical observations
Analytical layer
  |- disruption likelihood (ML)
  |- cascading consequence + systemic risk + confidence
  `- deterministic response playbooks
        |
        v
FastAPI ---- OpenAI: bounded explanations / leadership brief
        |
        v
React application: Risk Overview | Asset Risk | Response | Leadership
```

Canonical `SGW-*` identity is stable while source identifiers remain aliases. Asset state changes by advisory; relationships describe topology; assessments are derived. This permits a real or public-data adapter to replace the supplied synthetic data without changing the domain model.

## AI and analytical workflows

| Capability | Responsibility |
| --- | --- |
| Predictive ML | Lightweight relative disruption likelihood trained on synthetic history; not a production probability. |
| Graph analytics | Electricity-to-water dependency traversal and cascading community impact. |
| Deterministic analytics | Duration-aware consequence, backup/redundancy, systemic-risk tiering and confidence. |
| Rules engine | Transparent, versioned response recommendations from approved playbooks. |
| Generative AI (OpenAI) | Grounded operator Q&A, explanations, concise insights and leadership briefing drafts. |

The LLM does **not** calculate risk, invent dependencies, approve actions, or control infrastructure.

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite/vinext, Leaflet, OpenStreetMap context tiles |
| Backend | Python 3.11+, FastAPI |
| ML / graph | Lightweight model / dependency graph analysis |
| GenAI | OpenAI Responses API (optional) |
| Data | Deterministic synthetic JSON, seed 42 |
| Tests | pytest and Node rendered-HTML tests |

Map tiles are contextual only: SGW markers, polygons, overlays and all calculations remain available if OpenStreetMap tiles do not load.

## Run locally

Prerequisites: Python 3.11+ and Node.js 22.13+. From the repository root:

```powershell
python -m pip install -e ".[api,dev]"
npm --prefix frontend ci
```

The seed-42 dataset is already included. To regenerate the same fixture:

```powershell
python scripts/generate_synthetic_data.py
```

Start the backend in one terminal:

```powershell
python scripts/run_api.py
```

Start the frontend in a second terminal:

```powershell
npm --prefix frontend run dev
```

Open [http://localhost:3000](http://localhost:3000). Hurricane Iris at T-24 loads by default. API documentation is at [http://localhost:8000/docs](http://localhost:8000/docs).

## OpenAI configuration

Copy `.env.example` to `.env` and set `OPENAI_API_KEY=<your-key>`. This is optional: without a key, the deterministic offline narrator is used. If OpenAI is unavailable, risk assessment, dependencies, prioritisation and the full human response workflow continue to work.

## Recommended demo path

1. Open **Risk Overview** at T-48.
2. Advance to T-24 and observe S17 move #5 -> #1.
3. Open **S17 Asset Risk** and inspect `S17 -> P4 -> W12 -> H3/F2`.
4. Ask why S17 ranks above S31.
5. Open **Response** and review or approve the deterministic mitigation.
6. Complete P4 field verification; confidence becomes High while risk can remain Critical.
7. Open **Leadership**, generate a grounded Situation Brief, then approve it.

## Synthetic data, assumptions and limitations

All SGW assets, Hurricane Iris states, dependencies and observations are synthetic and deterministic (seed 42). The prototype models selected electric and water assets, simplified redundancy and one-hop electricity-to-water propagation. Thresholds and historical observations are demonstration assumptions.

It does not claim production predictive accuracy, connect to live SCADA, control infrastructure, autonomously dispatch crews, consume live weather, or implement production-grade RBAC/security. A real deployment requires calibrated models, real data integration, deeper geospatial and compound-hazard modelling, and ongoing LLM evaluation/monitoring.

## Human control and AI safety

Deterministic rules create recommendations. Authorised people approve, reject, assign, start and complete actions, with actor/time/history recorded. OpenAI can explain evidence and draft a briefing, but cannot create authoritative risk, approve actions or operate infrastructure.

## Tests

Run the clean-run gate and test suites from the repository root:

```powershell
python scripts/verify_clean_run.py
python -m pytest -q
npm --prefix frontend test
```

The golden-path regression verifies the T-48 -> T-24 S17 transition. The leadership trajectory regression also enforces `Landfall` as the API-stage token: the UI may display T-0, but must never request `?t=T-0`.

## Future enhancements

Real SGW integrations; calibrated models; streaming telemetry/anomaly detection; crew and resource optimisation; richer geospatial and compound-hazard analysis; imagery/computer vision where appropriate; and production identity, security and observability.
