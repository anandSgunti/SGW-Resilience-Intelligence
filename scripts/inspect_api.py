from sgw_platform.api import app


schema = app.openapi()
print(f"{schema['info']['title']} v{schema['info']['version']}")
for path, operations in sorted(schema["paths"].items()):
    for method in sorted(operations):
        if method in {"get", "post", "put", "patch", "delete"}:
            print(f"{method.upper():4} {path}")

platform = app.state.platform
state = platform.current_state("T-24")
leader = state["assessments"][0]
print(
    f"\nT-24 leader: {leader['sgw_id']} | "
    f"{leader['tier'].value.upper()} | risk={leader['risk_score']}"
)
print(f"Ranked assets: {len(state['assessments'])}; response actions: {len(state['responses'])}")
