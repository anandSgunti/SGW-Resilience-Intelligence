"use client";

import { useEffect, useMemo, useState } from "react";
import { useIncident } from "../IncidentContext";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

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


const priorityRing: Record<string, string> = {
  critical: "text-critical border-critical/50 bg-critical/10",
  high: "text-high border-high/50 bg-high/10",
  medium: "text-medium border-medium/50 bg-medium/10",
};
const toneClass: Record<string, string> = {
  worse: "text-critical", better: "text-verified", evidence: "text-medium", neutral: "text-muted-foreground",
};
const LIFECYCLE = ["recommended", "approved", "assigned", "in_progress", "completed"];

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="glass-chip press min-w-24 rounded-2xl px-4 py-3">
      <strong className={`block font-display text-2xl leading-none ${tone ?? "text-foreground"}`}>{value}</strong>
      <small className="eyebrow-mono mt-1.5 block">{label}</small>
    </div>
  );
}
function SectionLabel({ children, note }: { children: string; note?: string | undefined }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-border pb-2">
      <span className="eyebrow-mono">{children}</span>
      {note ? <small className="text-xs text-muted-foreground">{note}</small> : null}
    </div>
  );
}
function stamp(value: string) {
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
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

  return (
    <main className="ds-screen mx-auto w-full max-w-[1600px] px-5 pb-16 pt-6 md:px-8">
      <section className="panel rise flex flex-wrap items-center justify-between gap-5 p-6">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-11 w-1 rounded-full bg-[image:var(--gradient-ember)]" />
          <div>
            <p className="eyebrow-mono">Assess → Respond → Verify</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">{assetFocus ? `${compactId(assetFocus)} actions` : "All recommended actions"}</h1>
            <small className="text-xs text-muted-foreground">Response board · Turn risk into accountable action. Playbooks recommend. People approve, own and close. Recorded field results feed straight back into the assessment.</small>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Kpi label="Recommended" value={counts.recommended} tone="text-critical" />
          <Kpi label="Approved" value={counts.approved} />
          <Kpi label="Active" value={counts.active} tone="text-high" />
          <Kpi label="Completed" value={counts.completed} />
          <Kpi label="Field verified" value={counts.verified} tone="text-verified" />
        </div>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-5">
          <div className="panel rise p-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div><p className="eyebrow-mono">Operational queue</p><h2 className="mt-1 text-lg font-semibold">Recommended actions</h2></div>
              <div className="flex gap-1.5" aria-label="Action priority filter">
                {(["all", "critical", "high"] as QueueFilter[]).map((item) => (
                  <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}
                    className={`press rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${filter === item ? "border-primary/50 bg-primary/12 text-primary" : "border-border bg-surface/60 text-muted-foreground hover:text-foreground"}`}>
                    {title(item)}
                  </button>
                ))}
              </div>
            </div>

            {error && !state ? (
              <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                <strong className="text-sm">Unable to load response queue</strong>
                <p className="mt-1 text-xs text-muted-foreground">{error}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {filtered.map((item) => {
                  const active = selected?.recommendation_id === item.recommendation_id;
                  return (
                    <button key={item.recommendation_id}
                      onClick={() => { setSelectedId(item.recommendation_id); resetForms(); setOwner(item.owner ?? item.default_owner); setMessage(null); setLastVerification(null); setRuleOpen(false); setRationale(null); }}
                      className={`glass-chip press w-full rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 ${active ? "border-primary/45 shadow-[0_0_0_1px_var(--primary)]" : "border-border"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[11px] text-muted-foreground">{item.rule_id}</span>
                            <strong className="text-sm">{compactId(item.asset_id)}</strong>
                            {item.target_asset_id && item.target_asset_id !== item.asset_id ? <small className="text-xs text-muted-foreground">→ {compactId(item.target_asset_id)}</small> : null}
                            {item.action_class === "field_verification" ? <em className="rounded-full border border-medium/40 bg-medium/10 px-2 py-0.5 text-[10px] not-italic uppercase tracking-wider text-medium">Field verification</em> : null}
                          </div>
                          <b className="mt-1.5 block text-sm font-semibold">{item.title}</b>
                          <small className="mt-1 block text-xs text-muted-foreground">{item.evidence?.trigger[0]?.summary ?? item.reason}</small>
                          {item.evidence?.impact_summary ? <em className="mt-1.5 block text-[11px] not-italic text-high">{item.evidence.impact_summary}</em> : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${priorityRing[item.priority] ?? priorityRing.medium}`}>{item.priority}</span>
                          <small className="text-[11px] text-muted-foreground">{title(item.status)}</small>
                          <small className="text-[11px] text-muted-foreground">{item.owner ?? item.default_owner}</small>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {!filtered.length ? (
                  <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                    <strong className="text-sm">No matching actions</strong>
                    <p className="mt-1 text-xs text-muted-foreground">Change the priority filter to see all SGW actions.</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {verifications.length ? (
            <div className="panel rise p-5">
              <SectionLabel note={`${verifications.length} recorded`}>Field verification log</SectionLabel>
              <div className="flex flex-col gap-2.5">
                {verifications.map((item) => (
                  <article key={item.verification_id} className="glass-chip rounded-2xl px-4 py-3.5">
                    <header className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{compactId(item.verified_asset_id)}</strong>
                      <em className={`rounded-full border px-2 py-0.5 text-[10px] not-italic uppercase tracking-wider ${item.outcome === "unavailable" ? priorityRing.critical : item.outcome === "verified_degraded" ? priorityRing.high : "border-verified/50 bg-verified/10 text-verified"}`}>{title(item.outcome)}</em>
                      <small className="ml-auto text-[11px] text-muted-foreground">{stamp(item.recorded_at)}</small>
                    </header>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.narrative}</p>
                    <footer className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>Recorded by {item.verified_by}</span>
                      <span>Applied to {item.applied_to_advisories.length} advisor{item.applied_to_advisories.length === 1 ? "y" : "ies"}</span>
                      {item.dependent_asset_ids.length ? <span>Reassessed {item.dependent_asset_ids.map((id) => compactId(id)).join(", ")}</span> : null}
                    </footer>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="flex flex-col gap-5">
          {selected ? (
            <>
              <div className="panel rise p-6">
                <p className="eyebrow-mono">Selected recommendation</p>
                <h2 className="mt-1.5 font-display text-xl font-semibold">{selected.title}</h2>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${priorityRing[selected.priority] ?? priorityRing.medium}`}>{selected.priority}</span>
                  <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted-foreground">{title(selected.status)}</span>
                  {isVerification ? <span className="rounded-full border border-medium/40 bg-medium/10 px-2.5 py-0.5 text-[11px] text-medium">Field verification</span> : null}
                </div>

                <div className="workflow-path mt-4 flex flex-wrap gap-1.5" aria-label="Response lifecycle">
                  {LIFECYCLE.map((item, index) => {
                    const current = LIFECYCLE.indexOf(selected.status);
                    const done = current > index || selected.status === "completed";
                    return <span key={item} className={`rounded-full border px-2.5 py-1 text-[11px] ${item === selected.status ? "border-primary/50 bg-primary/12 text-primary" : done ? "border-verified/40 bg-verified/10 text-verified" : "border-border text-muted-foreground"}`}>{title(item)}</span>;
                  })}
                </div>

                <section className="mt-5">
                  <SectionLabel>Accountability</SectionLabel>
                  <div className="grid grid-cols-2 gap-2.5">
                    {([["Suggested owner", selected.default_owner], ["Current owner", selected.owner ?? "Not assigned"], ["Source asset", compactId(selected.asset_id)], ["Target", compactId(selected.target_asset_id)]] as Array<[string, string]>).map(([label, value]) => (
                      <div key={label} className="glass-chip rounded-2xl px-3.5 py-2.5">
                        <span className="block text-[11px] text-muted-foreground">{label}</span>
                        <strong className="text-sm">{value}</strong>
                      </div>
                    ))}
                  </div>
                  <Link href={`/asset-risk?asset=${encodeURIComponent(selected.asset_id)}&t=${encodeURIComponent(stage)}`}
                    className="mt-3 inline-block text-[11px] font-medium text-primary underline-offset-4 hover:underline">
                    Inspect {compactId(selected.asset_id)} dependency evidence →
                  </Link>
                </section>

                {selected.status === "recommended" ? (
                  <section className="mt-5">
                    <SectionLabel>Human decision required</SectionLabel>
                    <p className="text-xs text-muted-foreground">No operational work begins until an attributed decision is recorded.</p>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => setDecision("approve")} className={`press rounded-full border px-4 py-2 text-sm font-medium ${decision === "approve" ? "border-verified/60 bg-verified/15 text-verified" : "border-border bg-surface/70 hover:border-verified/40"}`}>Approve</button>
                      <button onClick={() => setDecision("reject")} className={`press rounded-full border px-4 py-2 text-sm font-medium ${decision === "reject" ? "border-critical/60 bg-critical/15 text-critical" : "border-border bg-surface/70 hover:border-critical/40"}`}>Reject</button>
                    </div>
                  </section>
                ) : null}

                {selected.status === "approved" ? (
                  <section className="mt-5">
                    <SectionLabel>Assign approved work</SectionLabel>
                    <p className="text-xs text-muted-foreground">Select the accountable operational team before work can begin.</p>
                    <button onClick={() => { setDecision("assign"); setOwner(selected.owner ?? selected.default_owner); }} className="press mt-3 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Assign owner</button>
                  </section>
                ) : null}

                {selected.status === "assigned" ? (
                  <section className="mt-5">
                    <SectionLabel>Ready to mobilize</SectionLabel>
                    <p className="text-xs text-muted-foreground">{selected.owner} owns this action. Starting it records the responsible operator and time.</p>
                    <button onClick={() => setDecision("start")} className="press mt-3 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Start work</button>
                  </section>
                ) : null}

                {selected.status === "in_progress" ? (
                  <section className="mt-5">
                    <SectionLabel>Work in progress</SectionLabel>
                    <p className="text-xs text-muted-foreground">{isVerification ? "Completion requires the observed field result. Risk and confidence are recalculated from what the team recorded." : "Completion requires an attributed operational note."}</p>
                    <button onClick={() => setDecision("complete")} className="press mt-3 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{isVerification ? "Record field result" : "Complete action"}</button>
                  </section>
                ) : null}

                {selected.status === "completed" ? (
                  <section className="mt-5 rounded-2xl border border-verified/40 bg-verified/10 p-4">
                    <strong className="text-sm text-verified">Action completed</strong>
                    <p className="mt-1 text-xs text-muted-foreground">This record is closed and preserved in the audit history.</p>
                  </section>
                ) : null}

                {selected.status === "rejected" ? (
                  <section className="mt-5 rounded-2xl border border-critical/40 bg-critical/10 p-4">
                    <strong className="text-sm text-critical">Recommendation rejected</strong>
                    <p className="mt-1 text-xs text-muted-foreground">The decision and reason remain preserved in the audit history.</p>
                  </section>
                ) : null}

                {decision ? (
                  <section className="mt-5 rounded-2xl border border-primary/25 bg-primary/5 p-4">
                    <SectionLabel>{`Record ${decision}`}</SectionLabel>
                    <div className="flex flex-col gap-3">
                      <label className="block text-[11px] text-muted-foreground">Operator name
                        <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="Required for audit"
                          className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60" />
                      </label>

                      {decision === "assign" ? (
                        <label className="block text-[11px] text-muted-foreground">Assigned owner
                          <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Operational team or owner"
                            className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60" />
                        </label>
                      ) : null}

                      {needsFieldResult ? (
                        <fieldset className="rounded-2xl border border-border p-3">
                          <legend className="px-1 text-[11px] text-muted-foreground">Observed field result</legend>
                          <div className="flex flex-wrap gap-2">
                            {FIELD_OUTCOMES.map((item) => (
                              <button type="button" key={item.value} aria-pressed={fieldOutcome === item.value} onClick={() => setFieldOutcome(item.value)}
                                className={`press rounded-full border px-3 py-1.5 text-xs ${fieldOutcome === item.value ? "border-primary/60 bg-primary/12 text-primary" : "border-border bg-surface/70 text-muted-foreground"}`}>{item.label}</button>
                            ))}
                          </div>
                          {fieldOutcome ? <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{FIELD_OUTCOMES.find((item) => item.value === fieldOutcome)?.hint}</p> : null}
                          {backupIsCollected ? (
                            <label className="mt-3 block text-[11px] text-muted-foreground">Verified backup endurance (hours)
                              <input type="number" min={0} max={720} step="0.5" value={confirmedBackup} onChange={(event) => setConfirmedBackup(event.target.value)} placeholder="Leave blank to keep the reported value"
                                className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60" />
                            </label>
                          ) : null}
                        </fieldset>
                      ) : null}

                      {decision === "reject" || decision === "complete" ? (
                        <label className="block text-[11px] text-muted-foreground">
                          {decision === "reject" ? "Decision reason" : needsFieldResult ? "Field result note" : "Completion note"}
                          <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)}
                            placeholder={decision === "reject" ? "Required for rejection" : needsFieldResult ? "For example: Generator operational, verified endurance 6h" : "Describe the completed work"}
                            className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60" />
                        </label>
                      ) : null}

                      <div className="flex justify-end gap-2">
                        <button onClick={resetForms} className="press rounded-full border border-border bg-surface/70 px-4 py-2 text-sm">Cancel</button>
                        <button onClick={() => void submitDecision()} disabled={submitting || !canSubmit}
                          className="press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
                          {submitting ? "Recording…" : needsFieldResult ? "Record field result" : `Record ${decision}`}
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}

                {message ? <div className="mt-4 rounded-2xl border border-verified/40 bg-verified/10 px-4 py-3 text-xs text-verified">{message}</div> : null}
                {error && state ? <div className="mt-4 rounded-2xl border border-critical/40 bg-critical/10 px-4 py-3 text-xs text-critical">{error}</div> : null}
              </div>

              <div className="panel rise p-6">
                <SectionLabel note={selected.evidence?.assessment_source}>Why this exists</SectionLabel>
                <div className="grid gap-2.5 md:grid-cols-3">
                  <div className="glass-chip rounded-2xl px-3.5 py-3">
                    <span className="eyebrow-mono">Trigger</span>
                    {(selected.evidence?.trigger ?? []).map((condition) => <b key={condition.summary} className="mt-1 block text-xs font-medium">{condition.summary}</b>)}
                    {!selected.evidence?.trigger.length ? <b className="mt-1 block text-xs font-medium">{selected.reason}</b> : null}
                  </div>
                  <div className="glass-chip rounded-2xl px-3.5 py-3">
                    <span className="eyebrow-mono">Impact</span>
                    <b className="mt-1 block text-xs font-medium">{selected.evidence?.impact_summary ?? "Not modelled"}</b>
                  </div>
                  <div className="glass-chip rounded-2xl px-3.5 py-3">
                    <span className="eyebrow-mono">Rule</span>
                    <b className="mt-1 block text-xs font-medium">{selected.rule ? `Playbook ${selected.rule.rule_id} · ${selected.rule.name}` : `Playbook ${selected.rule_id}`}</b>
                    {selected.rule ? <button type="button" aria-expanded={ruleOpen} onClick={() => setRuleOpen((current) => !current)} className="mt-2 text-[11px] font-medium text-primary underline-offset-4 hover:underline">{ruleOpen ? "Hide rule" : "View rule"}</button> : null}
                  </div>
                </div>

                {ruleOpen && selected.rule ? (
                  <div className="mt-3 rounded-2xl border border-border bg-surface-2 p-4">
                    <p className="text-xs leading-relaxed text-muted-foreground">{selected.rule.summary}</p>
                    <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                      {selected.rule.thresholds.map((threshold) => (
                        <div key={threshold.label} className="glass-chip rounded-xl px-3 py-2">
                          <dt className="text-[11px] text-muted-foreground">{threshold.label}</dt>
                          <dd className="text-xs font-medium">{threshold.value}</dd>
                        </div>
                      ))}
                    </dl>
                    <small className="mt-2 block text-[11px] text-muted-foreground">Published rule text. The matching logic stays in the playbook engine.</small>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <span className="text-[11px] text-muted-foreground">Rule version <strong className="text-foreground">{selected.rule ? `${selected.rule.rule_id} v${selected.rule.version}` : "unversioned"}</strong></span>
                  <span className="text-[11px] text-muted-foreground">Assessment source <strong className="text-foreground">{selected.evidence?.assessment_source ?? "—"}</strong></span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {selected.facts.map((fact) => (
                    <div key={fact.metric} className="glass-chip rounded-2xl px-3.5 py-2.5">
                      <span className="block text-[11px] text-muted-foreground">{factLabel(fact.metric)}</span>
                      <strong className="text-sm">{factValue(fact)}</strong>
                    </div>
                  ))}
                </div>

                <div className="mt-4">
                  <button type="button" onClick={() => void requestRationale()} disabled={rationaleLoading}
                    className="press rounded-full border border-border bg-surface/70 px-4 py-2 text-xs disabled:opacity-50">
                    {rationaleLoading ? "Rewriting…" : "Explain in plain language"}
                  </button>
                  {rationaleError ? <p className="mt-2 text-[11px] text-critical">{rationaleError}</p> : null}
                  <small className="mt-2 block text-[11px] text-muted-foreground">The narrator may reword the authored rationale. It is display-only and cannot create, modify or approve a playbook action.</small>
                  {rationale ? (
                    <div className="mt-3 rounded-2xl border border-border bg-surface-2 p-4">
                      <p className="text-xs leading-relaxed">{rationale.rationale}</p>
                      <small className="mt-2 block text-[11px] text-muted-foreground">{rationale.advisory_note} · {rationale.model} · {rationale.rule_id} v{rationale.rule_version}</small>
                      <small className="mt-1 block text-[11px] font-medium text-verified">Action still {title(rationale.status)} · narration changed nothing.</small>
                    </div>
                  ) : null}
                </div>
              </div>

              {impactPanel ? (
                <div className="panel rise p-6">
                  <SectionLabel note={stamp(impactPanel.recorded_at)}>Reassessment after field result</SectionLabel>
                  <p className="text-xs leading-relaxed text-muted-foreground">{impactPanel.narrative}</p>
                  {impactPanel.impacts.length ? (
                    <div className="mt-3 flex flex-col gap-2">
                      {impactPanel.impacts.map((impact, index) => (
                        <div key={`${impact.sgw_id}-${impact.metric}-${index}`} className="glass-chip flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5">
                          <span className="font-mono text-[11px] text-muted-foreground">{compactId(impact.sgw_id)}</span>
                          <span className="flex-1 text-xs">{factLabel(impact.metric)}</span>
                          <strong className={`text-xs ${toneClass[impactTone(impact)] ?? toneClass.neutral}`}>{String(impact.previous)} → {String(impact.current)}{impact.unit && impact.unit !== "points" ? impact.unit : ""}</strong>
                        </div>
                      ))}
                    </div>
                  ) : <p className="mt-3 text-xs text-muted-foreground">The recorded result did not move any assessment.</p>}
                </div>
              ) : null}

              {selected.history.length ? (
                <div className="panel rise p-6">
                  <SectionLabel note={`${selected.history.length} events`}>Audit trail</SectionLabel>
                  <div className="flex flex-col gap-3">
                    {selected.history.map((event, index) => (
                      <div key={`${event.occurred_at}-${index}`} className="flex gap-3">
                        <i className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/70" />
                        <div>
                          <strong className="block text-xs font-semibold">{title(event.status)}</strong>
                          <small className="text-[11px] text-muted-foreground">{event.actor}{event.owner ? ` → ${event.owner}` : ""} · {stamp(event.occurred_at)}</small>
                          {event.reason ? <p className="mt-1 text-xs text-muted-foreground">{event.reason}</p> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="panel rise p-10 text-center">
              <strong className="text-sm">Select an action</strong>
              <p className="mt-1 text-xs text-muted-foreground">Choose a recommendation to review its evidence and accountability.</p>
            </div>
          )}
        </aside>
      </section>
      <p className="mt-6 text-center text-[11px] text-muted-foreground">Nothing on this screen computes risk. Every score, trigger and reassessment is read from the backend.</p>
    </main>
  );
}
