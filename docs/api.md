# SGW API contract

Run the API with `python scripts/run_api.py`, then open `/docs` for the generated
OpenAPI interface.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Runtime health check |
| GET | `/api/state?t=T-24` | Advisory, rankings, map hazards and responses |
| GET | `/api/assets/{id}?t=T-24` | Asset assessment and dependency drill-down |
| POST | `/api/explain` | Grounded asset or platform Q&A |
| POST | `/api/responses/{id}` | Human response lifecycle decision |
| POST | `/api/briefings` | Create a versioned leadership briefing |
| POST | `/api/briefings/{id}/approve` | Approve edited briefing text |

Canonical `SGW-*` identifiers and known provider identifiers are accepted by the
asset route. Unknown assets/advisories return 404. Invalid human lifecycle
transitions return 409. Validation errors return 422.

The API is the calculation boundary. Clients should display its risk,
confidence, movement, dependency, evidence and response fields directly rather
than recomputing them.
