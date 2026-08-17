import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the SGW operational workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>SGW Resilience Command<\/title>/i);
  assert.match(html, /Resilience command/);
  assert.match(html, /Hurricane Iris/);
  assert.match(html, /Network exposure/);
  assert.match(html, /Priority assets/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/i);
});

test("priority rail implements the 6A.2 decision controls and evidence view", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /railMode/);
  assert.match(source, /railFilter/);
  for (const label of ["Priority", "Change", "Critical", "High", "Water", "Electric", "Likelihood", "Consequence", "topDriver", "Asset risk"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /focus-split/);
  assert.match(source, /index-item/);
  assert.match(source, /setSelectedId\(assessment\.sgw_id\)/);
});

test("revised 6A.1 map uses Leaflet with application-owned fallback layers", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const map = await readFile(new URL("../app/OperationalMap.tsx", import.meta.url), "utf8");
  for (const label of ["Assets", "Operational", "Hazard", "Service Zones", "Dependencies", "Storm Track", "Wind Exposure", "Flood Exposure"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(map, /import\("leaflet"\)/);
  assert.match(map, /tile\.openstreetmap\.org/);
  assert.match(map, /SGW assets and hazard overlays remain operational/);
  assert.match(map, /operatingZones/);
  assert.match(map, /hazardAreas/);
});

test("6A.3 surfaces material change as a headlines wire, plus grounded drawers", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // The per-asset change strip became a wire covering every mover at once.
  for (const label of ["What changed", "wire-belt", "headlines", "Top movers", "Grounded explanation"]) {
    assert.match(source, new RegExp(label));
  }
  // Every headline is derived from backend change drivers, never recomputed.
  assert.match(source, /topMovers\.map/);
  assert.match(source, /item\.primary_change/);
  assert.match(source, /No material change since/);
  assert.match(source, /\/api\/explain/);
  assert.match(source, /fact_pack_sha256/);
});

test("6A.4 keeps event identity in the nav and backend KPIs in the ribbon", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const nav = await readFile(new URL("../app/WorkflowNav.tsx", import.meta.url), "utf8");
  // Brand, event and freshness live in the shared top nav so every screen has them.
  for (const label of ["Resilience command", "Hurricane Iris"]) assert.match(nav, new RegExp(label));
  // Data freshness was a hardcoded constant dressed as live telemetry; it is gone.
  assert.doesNotMatch(nav, /data_freshness|dataFreshness/);
  // Advisory KPIs stay on Screen 1, read straight from the backend summary.
  for (const label of ["Residents exposed", "Open actions"]) assert.match(source, new RegExp(label));
  assert.match(source, /state\?\.summary\.critical_assets/);
  assert.match(source, /state\?\.summary\.exposed_residents/);
});

test("Screen 1 ribbon carries per-advisory trajectory, not just the current advisory", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // The ribbon replaces the old KPI strip and timeline: each stop shows that
  // advisory's own Critical count, so trajectory is legible without navigating.
  assert.match(source, /trajectory/);
  assert.match(source, /Promise\.allSettled\(TIMELINE\.map/);
  assert.match(source, /summary\.critical_assets/);
  assert.match(source, /ribbon-step/);
  assert.match(source, /focus-card/);
  // Chrome collapsed: the standalone KPI strip and timeline nav are gone.
  assert.doesNotMatch(source, /status-strip/);
  assert.doesNotMatch(source, /className="timeline"/);
});

test("6B.1 renders an interactive dependency graph with three evidence lenses", async () => {
  const response = await render("/asset-risk?asset=SGW-S17&t=T-24");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Why does this asset matter right now/);
  assert.match(html, /Dependency intelligence/);
  for (const label of ["Infrastructure", "Consequence", "Confidence", "Validated dependency", "Service consequence", "Unverified", "Material resilience gap"]) assert.match(html, new RegExp(label));
  const source = await readFile(new URL("../app/asset-risk/page.tsx", import.meta.url), "utf8");
  assert.match(source, /graphLayout/);
  assert.match(source, /setFocusedId/);
  assert.match(source, /node_context/);
  assert.match(source, /graph-edge--uncertain/);
});

test("6B.2 provides a complete generic selected-node detail panel", async () => {
  const source = await readFile(new URL("../app/asset-risk/page.tsx", import.meta.url), "utf8");
  for (const label of ["Selected node", "Operating context", "Why it matters", "Connected evidence", "Data confidence", "Create verification action", "Recommended response"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /relatedActions/);
  assert.match(source, /incoming\.some\(\(edge\) => edge\.relationship === "backup_feed"\)/);
  assert.match(source, /No field work is auto-approved/);
});

test("6B.3 adds grounded asset questions without moving risk logic into the client", async () => {
  const source = await readFile(new URL("../app/asset-risk/page.tsx", import.meta.url), "utf8");
  for (const label of ["Ask about this asset", "Facts only", "Why is S17 above S31", "What changed since the previous advisory", "What is uncertain", "Fact pack"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /\/api\/explain/);
  assert.match(source, /asset_id: context\.asset\.sgw_id/);
  assert.match(source, /answer\.grounded|Grounded/);
  assert.doesNotMatch(source, /calculateRisk|deriveConsequence/);
});

test("6C.1 renders the response queue and attributed approve-reject workflow", async () => {
  const response = await render("/respond?t=T-24&asset=SGW-S17");
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const label of ["Response board", "Turn risk into accountable action", "Operational queue"]) assert.match(html, new RegExp(label));
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  for (const label of ["Human decision required", "Approve", "Reject"]) assert.match(source, new RegExp(label));
  assert.match(source, /refreshIncident\(nextStage, reason\)/);
  assert.match(source, /\/api\/responses\/\$\{selected\.recommendation_id\}/);
  assert.match(source, /actor\.trim\(\)/);
  // Attribution is mandatory, and both reject and complete require a written reason.
  assert.match(source, /decision !== "reject" \|\| Boolean\(reason\.trim\(\)\)/);
  assert.match(source, /decision !== "complete" \|\| Boolean\(reason\.trim\(\)\)/);
  assert.match(source, /Audit trail/);
});

test("6C.2 completes the attributed assignment and execution lifecycle", async () => {
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  for (const label of ["Assign approved work", "Assign owner", "Start work", "Work in progress", "Complete action", "Completion note", "Action completed"]) assert.match(source, new RegExp(label));
  for (const action of ["assign", "start", "complete"]) assert.match(source, new RegExp(`decision === "${action}"|setDecision\\("${action}"\\)`));
  assert.match(source, /owner: decision === "assign"/);
  assert.match(source, /decision === "complete"/);
  assert.match(source, /workflow-path/);
  assert.match(source, /event\.owner/);
});

test("6C.3 records a field result and renders the backend reassessment", async () => {
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  for (const label of [
    "Observed field result", "Record field result", "Field result note",
    "Verified backup endurance", "Reassessment after field result",
    "Field verification log", "Field verified",
  ]) {
    assert.match(source, new RegExp(label));
  }
  for (const outcome of ["verified_operational", "verified_degraded", "unavailable"]) {
    assert.match(source, new RegExp(outcome));
  }
  // The result rides the existing decision endpoint on completion only.
  assert.match(source, /needsFieldResult = Boolean\(isVerification && decision === "complete"\)/);
  assert.match(source, /action_class === "field_verification"/);
  assert.match(source, /\/api\/responses\/\$\{selected\.recommendation_id\}/);
  assert.match(source, /confirmed_backup_hours/);
  assert.match(source, /payload\.verification/);
  // Screens read the loop, they never recompute it.
  assert.match(source, /impactPanel\.narrative/);
  assert.match(source, /impactPanel\.impacts\.map/);
  assert.match(source, /Nothing on this screen computes risk/);
  assert.doesNotMatch(source, /calculateRisk|deriveConsequence|recomputeConfidence/);
});

test("6C.3 keeps the lifecycle human-driven and surfaces backend conflicts", async () => {
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  // An outcome is mandatory before a verification action can be completed.
  assert.match(source, /\(!needsFieldResult \|\| fieldOutcome !== null\)/);
  assert.match(source, /disabled=\{submitting \|\| !canSubmit\}/);
  assert.match(source, /throw new Error\(payload\.detail \?\? "Decision could not be recorded"\)/);
  // Nothing self-approves, self-assigns or self-executes.
  for (const auto of [/setDecision\("approve"\);\s*void submitDecision/, /useEffect\([^)]*submitDecision/]) {
    assert.doesNotMatch(source, auto);
  }
  assert.match(source, /await loadState\(stage, needsFieldResult \? "field_evidence" : "human_action"\)/);
});

test("6C.3 renders the verification log after the loop has run", async () => {
  const response = await render("/respond?t=T-24&asset=SGW-S17");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Assess → Respond → Verify/);
  assert.match(html, /Field verified/);
});

test("6C.4 exposes trigger, impact and rule layers with provenance", async () => {
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  for (const label of [
    "Why this exists", "Trigger", "Impact", "Rule",
    "View rule", "Hide rule", "Rule version", "Assessment source",
  ]) {
    assert.match(source, new RegExp(label));
  }
  // All three layers are read from the backend contract, never assembled here.
  assert.match(source, /selected\.evidence\?\.trigger/);
  assert.match(source, /selected\.evidence\?\.impact_summary/);
  assert.match(source, /selected\.evidence\?\.assessment_source/);
  assert.match(source, /selected\.rule\.version/);
  assert.match(source, /selected\.rule\.thresholds\.map/);
  assert.match(source, /Published rule text/);
  // No raw predicate is ever rendered.
  assert.doesNotMatch(source, /RiskTier\.|assessment\.tier ==|max_uncovered_hours >/);
});

test("6C.4 keeps the narrator display-only and outside the playbook", async () => {
  const source = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Explain in plain language/);
  assert.match(source, /\/api\/responses\/\$\{selected\.recommendation_id\}\/rationale/);
  assert.match(source, /rationale\.advisory_note/);
  assert.match(source, /Action still \{title\(rationale\.status\)\}/);
  // Narrated text is rendered, never written back into a decision request.
  assert.doesNotMatch(source, /body: JSON\.stringify\(\{[^}]*rationale/);
  assert.doesNotMatch(source, /setDecision\([^)]*rationale/);
});

test("6C.4 renders evidence layers on the server-rendered board", async () => {
  const response = await render("/respond?t=T-24&asset=SGW-S17");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Why this exists|Select an action/);
  assert.match(html, /Response board/);
});

test("6E.1 preserves workflow context across all four screens", async () => {
  const nav = await readFile(new URL("../app/WorkflowNav.tsx", import.meta.url), "utf8");
  const overview = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const asset = await readFile(new URL("../app/asset-risk/page.tsx", import.meta.url), "utf8");
  const response = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  const leadership = await readFile(new URL("../app/leadership/page.tsx", import.meta.url), "utf8");
  for (const label of ["Risk Overview", "Asset Risk", "Response", "Leadership", "Assess", "Respond", "Inform"]) assert.match(nav, new RegExp(label));
  for (const key of ["t", "asset", "region", "filter", "railFilter", "railMode"]) assert.match(nav, new RegExp(`\\"${key}\\"`));
  assert.match(overview, /query\.set\("t", stage\)/);
  assert.match(overview, /query\.set\("asset", selectedId\)/);
  assert.match(asset, /query\.set\("asset", focusedId\)/);
  assert.match(response, /\/asset-risk\?asset=/);
  assert.match(response, /query\.set\("filter", filter\)/);
  assert.match(leadership, /filter=critical/);
});

test("6E.2 centralizes advisory refresh and keeps analytics in the backend", async () => {
  const context = await readFile(new URL("../app/IncidentContext.tsx", import.meta.url), "utf8");
  const response = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  const nav = await readFile(new URL("../app/WorkflowNav.tsx", import.meta.url), "utf8");
  for (const field of ["currentAdvisory", "currentEvent", "selectedAsset", "lastUpdated", "activeResponseState"]) assert.match(context, new RegExp(field));
  for (const reason of ["advisory_change", "human_action", "field_evidence"]) assert.match(context + response, new RegExp(reason));
  assert.match(context, /inFlight\.current\?\.advisory === advisory/);
  assert.match(context, /\/api\/state\?t=/);
  assert.match(nav, /Updating assessment/);
  assert.doesNotMatch(context, /calculateRisk|deriveConsequence|recomputeConfidence/);
});

test("6E.3 wires the golden Assess to Respond to Inform path without client analytics", async () => {
  const overview = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const asset = await readFile(new URL("../app/asset-risk/page.tsx", import.meta.url), "utf8");
  const response = await readFile(new URL("../app/respond/page.tsx", import.meta.url), "utf8");
  const leadership = await readFile(new URL("../app/leadership/page.tsx", import.meta.url), "utf8");
  assert.match(overview, /\/asset-risk\?asset=\$\{encodeURIComponent\(selectedAsset\.sgw_id\)\}&t=/);
  assert.match(asset, /Why is S17 above S31/);
  assert.match(asset, /Create verification action/);
  assert.match(asset, /\/respond\?t=/);
  assert.match(response, /verified_operational/);
  assert.match(response, /field_evidence/);
  assert.match(response, /\/asset-risk\?asset=/);
  assert.match(leadership, /Generate draft brief/);
  assert.match(leadership, /Approve/);
  for (const source of [overview, asset, response, leadership]) assert.doesNotMatch(source, /calculateRisk|deriveConsequence|recomputeConfidence/);
});

test("6D.4 uses only canonical backend advisory stages for the leadership trajectory", async () => {
  const leadership = await readFile(new URL("../app/leadership/page.tsx", import.meta.url), "utf8");
  assert.match(leadership, /"T-72", "T-48", "T-24", "T-12", "Landfall"/);
  assert.doesNotMatch(leadership, /"T-0"/);
  // allSettled, not all: a single unreachable advisory must not blank the strip.
  assert.match(leadership, /Promise\.allSettled\(STAGES\.map/);
  assert.match(leadership, /largestMover/);
});
