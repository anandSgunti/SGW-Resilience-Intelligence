# Step 5J backend acceptance gate

Run:

```powershell
python scripts/generate_synthetic_data.py
python scripts/verify_milestone.py
python -m pytest -q
```

The verifier is a release gate, not a demo-only printout. It exits non-zero if
any checkpoint fails and supports `--json` for future CI automation.

| Checkpoint | Acceptance evidence |
|---|---|
| Data foundation | Committed fixture exactly matches seed-42 regeneration |
| Canonical federation | GIS and field identifiers resolve to `SGW-S17` |
| Dependency engine | Golden chain and alternate-feed patterns traverse correctly |
| Risk engine | S17 moves High/#2 to Critical/#1 from the 4h→14h restoration update against 6h backup |
| Comparison logic | S31 remains more likely but less consequential than S17 |
| Flood scenario | P11 direct exposure creates deterministic R4 response |
| Playbooks | S17 creates R1, R2, R3 and R5 from assessment evidence |
| Human control | Approve/assign/start/complete retains four audit events |
| API | All seven locked route contracts appear in OpenAPI |
| LLM-down behavior | Deterministic grounded explanation works without an API call |

Passing this gate means the backend foundation is ready for frontend work. It
does not claim that persistence, production security, deployment or the final
demonstration package are complete.
