"use client";

import { useEffect, useMemo, useState } from "react";
import { useIncident } from "../IncidentContext";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type Fact = { metric: string; value: string | number; unit: string | null };
type HistoryEvent = { status: string; occurred_at: string; actor: string; owner: string | null; reason: string | null };
type RuleThreshold = { label: string; value: string };
type PlaybookRule = { rule_id: string; version: string; name: string; summary: string; action_class: string; default_owner: string; thresholds: RuleThreshold[] };
type TriggerCondition = { summary: string; left_label: string; left_value: string | number; operator: string; right_label: string; right_value: string | number; unit: string | null };
type Evidence = { trigger: TriggerCondition[]; impact_items: string[]; impact_summary: string; assessment_source: string; advisory_id: string; assessed_tier: string; assessed_risk_score: number; state_reported_at: string | null };
type Rationale = { rationale: string; authored_rationale: string; rule_id: string; rule_version: string; assessment_source: string; status: string; model: string; fact_pack_sha256: string; advisory_note: string };
type Recommendation = { recommendation_id: string; rule_id: string; asset_id: string; target_asset_id: string | null; advisory_id: string; title: string; reason: string; facts: Fact[]; priority: string; default_owner: string; action_class: string; rule: PlaybookRule | null; evidence: Evidence | null; status: string; owner: string | null; history: HistoryEvent[] };
type VerificationImpact = { sgw_id: string; metric: string; previous: string | number | null; current: string | number | null; unit: string | null; direction: string; summary: string };
type Verification = { verification_id: string; advisory_id: string; verified_asset_id: string; dependent_asset_ids: string[]; recommendation_id: string | null; outcome: string; detail: string; verified_by: string; recorded_at: string; impacts: VerificationImpact[]; narrative: string; applied_to_advisories: string[] };
type StatePayload = { advisory: { stage: string; issued_at: string }; summary: { open_actions: number }; responses: Recommendation[]; verifications: Verification[] };
type QueueFilter = "all" | "critical" | "high";
type Decision = "approve" | "reject" | "assign" | "start" | "complete";
type FieldOutcome = "verified_operational" | "verified_degraded" | "unavailable";

const API_URL = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";
const FIELD_OUTCOMES: Array<{ value: FieldOutcome; label: string; hint: string }> = [
  { value: "verified_operational", label: "Operational", hint: "Readiness confirmed on site. Evidence improves; risk is recalculated, not assumed." },
  { value: "verified_degraded", label: "Degraded", hint: "Partially available. Confirmed endurance replaces the assumed value." },
  { value: "unavailable", label: "Unavailable", hint: "No usable backup. The uncovered service gap widens and consequence is recalculated." },
];

function compactId(value: string | null) { return value?.replace("SGW-", "") ?? "—"; }
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function factLabel(value: string) { return title(value).replace("Hours", "").replace("Score", "").trim(); }
function factValue(fact: Fact) { return `${fact.value}${fact.unit === "hours" ? "h" : fact.unit === "residents" ? " residents" : fact.unit === "facilities" ? " facilities" : fact.unit === "points" ? "" : fact.unit ? ` ${fact.unit}` : ""}`; }
function impactTone(impact: VerificationImpact) {
  if (impact.metric === "confidence" || impact.metric === "confidence_score" || impact.metric === "verification_status") return "evidence";
  if (impact.direction === "increased" || impact.direction === "reassessed") return "worse";
  if (impact.direction === "decreased") return "better";
  return "neutral";
}

export default function RespondPage() {
  const searchParams = useSearchParams();
  const { refreshIncident, setCurrentAdvisory, setSelectedAsset } = useIncident();
    // Seeded from the URL during render so the server and client agree; no
  // effect writes this state back on mount.
  const [stage] = useState(() => searchParams?.get("t") ?? "T-24");
  const [assetFocus] = useState<string | null>(() => searchParams?.get("asset") ?? null);
  const [state, setState] = useState<StatePayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [actor, setActor] = useState("");
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [fieldOutcome, setFieldOutcome] = useState<FieldOutcome | null>(null);
  const [confirmedBackup, setConfirmedBackup] = useState("");
  const [lastVerification, setLastVerification] = useState<Verification | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [rationale, setRationale] = useState<Rationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [rationaleError, setRationaleError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadState(nextStage = stage, reason: "advisory_change" | "human_action" | "field_evidence" = "advisory_change") {
    const payload = await refreshIncident(nextStage, reason) as unknown as StatePayload; setState(payload);
    setSelectedId((current) => current && payload.responses.some((item) => item.recommendation_id === current) ? current : (payload.responses.find((item) => !assetFocus || item.asset_id === assetFocus)?.recommendation_id ?? payload.responses[0]?.recommendation_id ?? null));
  }
  useEffect(() => { void Promise.resolve().then(() => setError(null)).then(() => loadState(stage)).catch(() => setError("The response queue is temporarily unavailable.")); }, [stage]);

  const responses = state?.responses ?? [];
  const verifications = state?.verifications ?? [];
  const filtered = useMemo(() => responses.filter((item) => (filter === "all" || item.priority === filter) && (!assetFocus || item.asset_id === assetFocus)), [responses, filter, assetFocus]);
  const selected = filtered.find((item) => item.recommendation_id === selectedId) ?? filtered[0] ?? null;
  useEffect(() => { const query = new URLSearchParams(window.location.search); query.set("t", stage); query.set("filter", filter); if (selected?.asset_id) { query.set("asset", selected.asset_id); setSelectedAsset(selected.asset_id); } setCurrentAdvisory(stage); window.history.replaceState(null, "", `/respond?${query.toString()}`); }, [filter, selected?.asset_id, setCurrentAdvisory, setSelectedAsset, stage]);
  const counts = { recommended: responses.filter((item) => item.status === "recommended").length, approved: responses.filter((item) => item.status === "approved").length, active: responses.filter((item) => ["assigned", "in_progress"].includes(item.status)).length, completed: responses.filter((item) => item.status === "completed").length, verified: verifications.length };
  const isVerification = selected?.action_class === "field_verification";
  const needsFieldResult = Boolean(isVerification && decision === "complete");
  const selectedVerification = selected ? verifications.find((item) => item.recommendation_id === selected.recommendation_id) ?? null : null;
  const impactPanel = lastVerification ?? selectedVerification;
  const backupIsCollected = needsFieldResult && fieldOutcome !== null && fieldOutcome !== "unavailable";
  const canSubmit = Boolean(selected && decision && actor.trim())
    && (decision !== "assign" || Boolean(owner.trim()))
    && (decision !== "reject" || Boolean(reason.trim()))
    && (decision !== "complete" || Boolean(reason.trim()))
    && (!needsFieldResult || fieldOutcome !== null);

  function resetForms() { setDecision(null); setReason(""); setFieldOutcome(null); setConfirmedBackup(""); }

  async function requestRationale() {
    if (!selected) return;
    setRationaleLoading(true); setRationaleError(null); setRationale(null);
    try {
      const response = await fetch(`${API_URL}/api/responses/${selected.recommendation_id}/rationale`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const payload = await response.json() as Rationale & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "Plain-language rationale unavailable");
      setRationale(payload);
    } catch (requestError) { setRationaleError(requestError instanceof Error ? requestError.message : "Plain-language rationale unavailable."); }
    finally { setRationaleLoading(false); }
  }

  async function submitDecision() {
    if (!selected || !decision || !canSubmit) return;
    setSubmitting(true); setError(null); setMessage(null);
    const backupValue = Number(confirmedBackup);
    const result = needsFieldResult && fieldOutcome ? {
      outcome: fieldOutcome,
      detail: reason.trim(),
      verified_by: selected.owner ?? actor.trim(),
      confirmed_backup_hours: backupIsCollected && confirmedBackup.trim() && Number.isFinite(backupValue) ? backupValue : undefined,
    } : undefined;
    try {
      const response = await fetch(`${API_URL}/api/responses/${selected.recommendation_id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: decision, actor: actor.trim(), owner: decision === "assign" ? owner.trim() : undefined, reason: decision === "reject" || decision === "complete" ? reason.trim() : undefined, result }) });
      const payload = await response.json() as { detail?: string; verification?: Verification | null };
      if (!response.ok) throw new Error(payload.detail ?? "Decision could not be recorded");
      setLastVerification(payload.verification ?? null);
      setMessage(payload.verification ? "Field result recorded. The backend reassessed every affected asset." : `${title(decision)} recorded with operator attribution.`);
      resetForms(); await loadState(stage, needsFieldResult ? "field_evidence" : "human_action");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Decision could not be recorded."); }
    finally { setSubmitting(false); }
  }

  return <main className="response-shell">
    <header className="response-topbar"><Link href="/" className="back-link">← Risk overview</Link><div><p className="eyebrow">Southeastern Grid &amp; Water</p><strong>Response board</strong></div><div className="asset-advisory"><span>Hurricane Iris · {state?.advisory.stage ?? stage}</span><i>Active</i></div></header>
    <section className="response-hero"><div><p className="eyebrow">Assess → Respond → Verify</p><h1>Turn risk into accountable action</h1><p>Playbooks recommend. People approve, reject, and own the operational response. Recorded field results feed straight back into the assessment.</p></div><div className="response-counts"><span><strong>{counts.recommended}</strong>Recommended</span><span><strong>{counts.approved}</strong>Approved</span><span><strong>{counts.active}</strong>Active</span><span><strong>{counts.completed}</strong>Completed</span><span><strong>{counts.verified}</strong>Field verified</span></div></section>
    <section className="response-workspace">
      <div className="response-queue"><div className="queue-toolbar"><div><p className="eyebrow">Operational queue</p><h2>{assetFocus ? `${compactId(assetFocus)} actions` : "All recommended actions"}</h2></div><div className="queue-filters" aria-label="Action priority filter">{(["all", "critical", "high"] as QueueFilter[]).map((item) => <button key={item} className={filter === item ? "queue-filter queue-filter--active" : "queue-filter"} onClick={() => setFilter(item)} aria-pressed={filter === item}>{title(item)}</button>)}</div></div>
        {error && !state ? <div className="queue-empty"><strong>Unable to load response queue</strong><p>{error}</p></div> : <div className="action-list">{filtered.map((item) => <button key={item.recommendation_id} className={`action-card action-card--${item.priority}${selected?.recommendation_id === item.recommendation_id ? " action-card--selected" : ""}`} onClick={() => { setSelectedId(item.recommendation_id); resetForms(); setOwner(item.owner ?? item.default_owner); setMessage(null); setError(null); setLastVerification(null); setRuleOpen(false); setRationale(null); setRationaleError(null); }}><span className="action-rank">{item.rule_id}</span><span className="action-copy"><span><strong>{compactId(item.asset_id)}</strong>{item.target_asset_id && item.target_asset_id !== item.asset_id && <small>→ {compactId(item.target_asset_id)}</small>}{item.action_class === "field_verification" && <i className="action-class-tag">Field verification</i>}</span><b>{item.title}</b><small>{item.evidence?.trigger[0]?.summary ?? item.reason}</small><span className="action-facts">{item.evidence?.impact_summary && <i className="action-impact">{item.evidence.impact_summary}</i>}{item.rule && <i>{item.rule.rule_id} v{item.rule.version}</i>}</span></span><span className="action-meta"><i className={`action-status action-status--${item.status}`}>{title(item.status)}</i><small>{item.owner ?? item.default_owner}</small><b>{title(item.priority)}</b></span></button>)}{!filtered.length && <div className="queue-empty"><strong>No matching actions</strong><p>Change the priority filter or return to all SGW actions.</p></div>}</div>}
        {verifications.length > 0 && <div className="verification-log"><div className="queue-toolbar"><div><p className="eyebrow">Closed evidence loop</p><h2>Field verification log</h2></div></div>{verifications.map((item) => <article key={item.verification_id} className="verification-entry"><header><strong>{compactId(item.verified_asset_id)}</strong><i className={`verification-outcome verification-outcome--${item.outcome}`}>{title(item.outcome)}</i><small>{new Date(item.recorded_at).toLocaleString()}</small></header><p className="verification-narrative">{item.narrative}</p><footer><span>Recorded by {item.verified_by}</span><span>Applied to {item.applied_to_advisories.length} advisor{item.applied_to_advisories.length === 1 ? "y" : "ies"}</span>{item.dependent_asset_ids.length > 0 && <span>Reassessed {item.dependent_asset_ids.map(compactId).join(", ")}</span>}</footer></article>)}</div>}
      </div>
      <aside className="response-detail">{selected ? <><div className="response-detail-heading"><p className="eyebrow">Selected recommendation</p><h2>{selected.title}</h2><div><span className={`tier-pill tier-pill--${selected.priority}`}>{selected.priority}</span><span className={`action-status action-status--${selected.status}`}>{title(selected.status)}</span>{isVerification && <span className="action-class-tag">Field verification</span>}</div></div>
        <div className="workflow-path" aria-label="Response lifecycle">{["recommended", "approved", "assigned", "in_progress", "completed"].map((item, index, path) => { const current = path.indexOf(selected.status); return <span key={item} className={`${item === selected.status ? "workflow-step workflow-step--current" : "workflow-step"}${current > index || selected.status === "completed" ? " workflow-step--done" : ""}`}>{title(item)}</span>; })}</div>
        <section className="evidence-block"><span className="response-section-label">Why this exists</span>
          <div className="evidence-layers">
            <div className="evidence-layer"><span>Trigger</span><div>{(selected.evidence?.trigger ?? []).map((condition) => <b key={condition.summary}>{condition.summary}</b>)}{!selected.evidence?.trigger.length && <b>{selected.reason}</b>}</div></div>
            <div className="evidence-layer"><span>Impact</span><div><b>{selected.evidence?.impact_summary ?? "Not modelled"}</b></div></div>
            <div className="evidence-layer"><span>Rule</span><div><b>{selected.rule ? `Playbook ${selected.rule.rule_id} · ${selected.rule.name}` : `Playbook ${selected.rule_id}`}</b>{selected.rule && <button type="button" className="rule-toggle" onClick={() => setRuleOpen((current) => !current)} aria-expanded={ruleOpen}>{ruleOpen ? "Hide rule" : "View rule"}</button>}</div></div>
          </div>
          <div className="provenance-row"><span>Rule version<strong>{selected.rule ? `${selected.rule.rule_id} v${selected.rule.version}` : "unversioned"}</strong></span><span>Assessment source<strong>{selected.evidence?.assessment_source ?? "—"}</strong></span></div>
          {ruleOpen && selected.rule && <div className="rule-detail"><p>{selected.rule.summary}</p><dl>{selected.rule.thresholds.map((threshold) => <div key={threshold.label}><dt>{threshold.label}</dt><dd>{threshold.value}</dd></div>)}</dl><small>Published rule text. The matching logic itself stays in the backend playbook engine.</small></div>}
          <div className="decision-facts">{selected.facts.map((fact) => <div key={fact.metric}><span>{factLabel(fact.metric)}</span><strong>{factValue(fact)}</strong></div>)}</div>
          <div className="rationale-block"><button type="button" className="rationale-button" onClick={() => void requestRationale()} disabled={rationaleLoading}>{rationaleLoading ? "Rewriting…" : "Explain in plain language"}</button>{rationaleError && <p className="rationale-error">{rationaleError}</p>}{rationale && <><p className="rationale-text">{rationale.rationale}</p><small className="rationale-note">{rationale.model} · {rationale.advisory_note} Action still {title(rationale.status)}.</small></>}</div>
        </section>
        <section><span className="response-section-label">Accountability</span><div className="accountability-grid"><span>Suggested owner<strong>{selected.default_owner}</strong></span><span>Current owner<strong>{selected.owner ?? "Not assigned"}</strong></span><span>Source asset<a href={`/asset-risk?asset=${encodeURIComponent(selected.asset_id)}&t=${encodeURIComponent(stage)}`}><strong>{compactId(selected.asset_id)} →</strong></a></span><span>Target<strong>{compactId(selected.target_asset_id)}</strong></span></div></section>
        {selected.status === "recommended" && <section className="human-decision"><span className="response-section-label">Human decision required</span><p>No operational work begins until an attributed decision is recorded.</p><div className="decision-buttons"><button className={decision === "approve" ? "decision-button decision-button--approve decision-button--active" : "decision-button decision-button--approve"} onClick={() => setDecision("approve")}>Approve</button><button className={decision === "reject" ? "decision-button decision-button--reject decision-button--active" : "decision-button decision-button--reject"} onClick={() => setDecision("reject")}>Reject</button></div></section>}
        {selected.status === "approved" && <section className="human-decision"><span className="response-section-label">Assign approved work</span><p>Select the accountable operational team before work can begin.</p><button className="workflow-primary" onClick={() => { setDecision("assign"); setOwner(selected.owner ?? selected.default_owner); }}>Assign owner</button></section>}
        {selected.status === "assigned" && <section className="human-decision"><span className="response-section-label">Ready to mobilize</span><p>{selected.owner} owns this action. Starting it records the responsible operator and time.</p><button className="workflow-primary" onClick={() => setDecision("start")}>Start work</button></section>}
        {selected.status === "in_progress" && <section className="human-decision"><span className="response-section-label">Work in progress</span><p>{isVerification ? "Completion requires the observed field result. The backend recalculates risk and confidence from what the team recorded." : "Completion requires an attributed operational note."}</p><button className="workflow-primary" onClick={() => setDecision("complete")}>{isVerification ? "Record field result" : "Complete action"}</button></section>}
        {selected.status === "completed" && <section className="workflow-terminal workflow-terminal--complete"><strong>Action completed</strong><p>This record is closed and preserved in the audit history.</p></section>}
        {selected.status === "rejected" && <section className="workflow-terminal workflow-terminal--rejected"><strong>Recommendation rejected</strong><p>The decision and reason remain preserved in the audit history.</p></section>}
        {decision && <section className="transition-panel"><span className="response-section-label">Record {decision}</span><div className="decision-form">
          <label>Operator name<input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="Required for audit" /></label>
          {decision === "assign" && <label>Assigned owner<input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Operational team or owner" /></label>}
          {needsFieldResult && <fieldset className="field-result"><legend>Observed field result</legend><div className="field-outcomes">{FIELD_OUTCOMES.map((item) => <button type="button" key={item.value} className={fieldOutcome === item.value ? "field-outcome field-outcome--active" : "field-outcome"} onClick={() => setFieldOutcome(item.value)} aria-pressed={fieldOutcome === item.value}>{item.label}</button>)}</div>{fieldOutcome && <p className="field-outcome-hint">{FIELD_OUTCOMES.find((item) => item.value === fieldOutcome)?.hint}</p>}{backupIsCollected && <label>Verified backup endurance (hours)<input type="number" min={0} max={720} step="0.5" value={confirmedBackup} onChange={(event) => setConfirmedBackup(event.target.value)} placeholder="Leave blank to keep the reported value" /></label>}</fieldset>}
          {(decision === "reject" || decision === "complete") && <label>{decision === "reject" ? "Decision reason" : needsFieldResult ? "Field result note" : "Completion note"}<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={decision === "reject" ? "Required for rejection" : needsFieldResult ? "For example: Generator operational, verified endurance 6h" : "Describe the completed work"} rows={3} /></label>}
          <div className="transition-actions"><button className="transition-cancel" onClick={resetForms}>Cancel</button><button onClick={() => void submitDecision()} disabled={submitting || !canSubmit}>{submitting ? "Recording…" : needsFieldResult ? "Record field result" : `Record ${decision}`}</button></div>
        </div></section>}
        {impactPanel && <section className="reassessment-panel"><span className="response-section-label">Reassessment after field result</span><p className="verification-narrative">{impactPanel.narrative}</p>{impactPanel.impacts.length > 0 ? <div className="impact-list">{impactPanel.impacts.map((impact, index) => <div key={`${impact.sgw_id}-${impact.metric}-${index}`} className={`impact-row impact-row--${impactTone(impact)}`}><span className="impact-asset">{compactId(impact.sgw_id)}</span><span className="impact-metric">{factLabel(impact.metric)}</span><strong>{String(impact.previous)} → {String(impact.current)}{impact.unit && impact.unit !== "points" ? impact.unit : ""}</strong></div>)}</div> : <p>The recorded result did not move any assessment.</p>}<small className="impact-footnote">Every value above was recalculated by the backend from the recorded observation. Nothing on this screen computes risk.</small></section>}
        {selected.history.length > 0 && <section><span className="response-section-label">Audit trail</span><div className="audit-list">{selected.history.map((event, index) => <div key={`${event.occurred_at}-${index}`}><i /><span><strong>{title(event.status)}</strong><small>{event.actor}{event.owner ? ` → ${event.owner}` : ""} · {new Date(event.occurred_at).toLocaleString()}</small>{event.reason && <p>{event.reason}</p>}</span></div>)}</div></section>}
        {message && <div className="decision-message">{message}</div>}
        {error && state && <div className="decision-error">{error}</div>}
      </> : <div className="queue-empty"><strong>Select an action</strong><p>Choose a recommendation to review its evidence and accountability.</p></div>}</aside>
    </section>
  </main>;
}
