"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useIncident } from "../IncidentContext";
import Link from "next/link";

type Assessment = { sgw_id: string; tier: string; rank: number; risk_score: number; affected_population: number; primary_change: string | null; confidence?: { level: string; reasons: string[] } };
type Response = { recommendation_id: string; asset_id: string; title: string; priority: string; status: string; owner: string | null };
type State = { advisory: { stage: string; advisory_id: string; issued_at: string; storm_category: number }; summary: { critical_assets: number; high_assets: number; exposed_residents: number; open_actions: number }; assessments: Assessment[]; responses: Response[] };
type Briefing = { briefing_id: string; advisory_id: string; version: number; text: string; fact_pack_sha256: string; model: string; status: string; created_at: string | null; approved_by: string | null; approved_at: string | null; final_text: string | null };
const API = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";
// These are backend advisory stages, not display aliases. The final event
// stage is `Landfall`; using `T-0` would 404 and invalidate the full timeline.
const STAGES = ["T-72", "T-48", "T-24", "T-12", "Landfall"];
// Display aliases only. STAGES above holds the tokens actually requested;
// the final advisory is sent as `Landfall` and shown as `T-0`.
const STAGE_LABELS = [{ value: "Landfall", label: "T-0" }];
const stageLabel = (value: string) => STAGE_LABELS.find((item) => item.value === value)?.label ?? value;
const compact = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
// Owned means a named team is accountable. Approval is a decision, not an
// assignment, so it deliberately does not count toward coverage.
const isOwned = (status: string) => ["assigned", "in_progress", "completed"].includes(status);
const isOpen = (status: string) => ["recommended", "approved"].includes(status);

export default function LeadershipPage() {
  const { setCurrentAdvisory, refreshIncident } = useIncident();
  const searchParams = useSearchParams();
  // Seeded from the URL during render, so the server and client agree and no
  // effect has to write state back on mount.
  const [stage, setStage] = useState(() => searchParams?.get("t") ?? "T-24");
  const [state, setState] = useState<State | null>(null);
  const [timeline, setTimeline] = useState<Record<string, State>>({});
  const [left, setLeft] = useState("T-48"); const [right, setRight] = useState("T-24");
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [draft, setDraft] = useState(""); const [approver, setApprover] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);

  async function getState(value: string) { const response = await fetch(`${API}/api/state?t=${encodeURIComponent(value)}`); if (!response.ok) throw new Error("Situation unavailable"); return response.json() as Promise<State>; }
  useEffect(() => { setCurrentAdvisory(stage); }, [stage, setCurrentAdvisory]);
  useEffect(() => { void refreshIncident(stage, "advisory_change").then((payload) => setState(payload as unknown as State)).catch(() => setError("The leadership situation view is temporarily unavailable.")); }, [stage]);
  // allSettled, not all: one unreachable advisory must degrade to a single
  // blank tile rather than blanking the whole trajectory strip.
  useEffect(() => {
    void Promise.allSettled(STAGES.map((item) => getState(item))).then((results) => {
      const loaded = results.flatMap((result, index) => result.status === "fulfilled" ? [[STAGES[index], result.value] as const] : []);
      setTimeline(Object.fromEntries(loaded));
      if (!loaded.length) setError("The advisory trajectory is temporarily unavailable.");
    });
  }, []);

  const critical = useMemo(() => (state?.assessments ?? []).filter((item) => item.tier === "critical"), [state]);
  const readiness = useMemo(() => {
    const criticalIds = new Set(critical.map((item) => item.sgw_id));
    const actions = (state?.responses ?? []).filter((item) => criticalIds.has(item.asset_id) || item.priority === "critical");
    // A risk is only covered when every action raised against it has an owner,
    // so coverage can never read 100% while actions are still unassigned.
    const coveredRisks = [...criticalIds].filter((id) => {
      const own = actions.filter((item) => item.asset_id === id);
      return own.length > 0 && own.every((item) => isOwned(item.status));
    }).length;
    const unassigned = actions.filter((item) => isOpen(item.status)).length;
    const material = [...actions].sort((a, b) => Number(b.priority === "critical") - Number(a.priority === "critical") || a.asset_id.localeCompare(b.asset_id)).slice(0, 3);
    return { coveredRisks, actions, material, unassigned,
      active: actions.filter((item) => item.status === "in_progress").length,
      completed: actions.filter((item) => item.status === "completed").length,
      ownedActions: actions.filter((item) => isOwned(item.status)).length,
      coverage: actions.length ? Math.round((actions.filter((item) => isOwned(item.status)).length / actions.length) * 100) : 0 };
  }, [critical, state]);
  const compare = useMemo(() => ({ before: timeline[left], after: timeline[right] }), [left, right, timeline]);
  const before = compare.before;
  const after = compare.after;
  const worsening = Boolean(after && before && after.summary.critical_assets > before.summary.critical_assets);
  /* Largest mover is measured across the two advisories actually selected
     above, not read off `primary_change` — that field is computed against each
     advisory's immediate predecessor, so it can report a move outside the
     window being compared.

     Movement is ranked by risk-score delta, not by rank delta. Rank change is
     quantised and depends on how crowded the neighbourhood is: climbing five
     places through a packed midfield is less movement than climbing four
     places into #1 on three times the risk change. Rank delta breaks ties and
     is shown alongside because leadership reads the ranked list. Assets absent
     from the earlier advisory have no measurable movement. */
  const largestMover = useMemo(() => {
    if (!before || !after) return null;
    const priorRank = new Map(before.assessments.map((item) => [item.sgw_id, item.rank]));
    const priorRisk = new Map(before.assessments.map((item) => [item.sgw_id, item.risk_score]));
    const moved = after.assessments.flatMap((item) => {
      const wasRank = priorRank.get(item.sgw_id);
      const wasRisk = priorRisk.get(item.sgw_id);
      if (wasRank === undefined || wasRisk === undefined) return [];
      // Positive rankDelta means the asset climbed towards #1.
      return [{ item, rankDelta: wasRank - item.rank, riskDelta: Math.round((item.risk_score - wasRisk) * 10) / 10, wasRank }];
    });
    const ranked = moved
      .filter((entry) => entry.rankDelta !== 0 || entry.riskDelta !== 0)
      .sort((a, b) =>
        Math.abs(b.riskDelta) - Math.abs(a.riskDelta)
        || Math.abs(b.rankDelta) - Math.abs(a.rankDelta)
        || a.item.sgw_id.localeCompare(b.item.sgw_id));
    return ranked[0] ?? null;
  }, [before, after]);
  const sourceFacts = useMemo(() => state ? [
    `Advisory ${state.advisory.stage} · ${state.advisory.issued_at}`, `${state.summary.critical_assets} Critical · ${state.summary.high_assets} High`,
    `${compact(state.summary.exposed_residents)} residents exposed`, `${readiness.coverage}% mitigation coverage`,
    `Unresolved critical actions: ${readiness.unassigned}`, `Top systemic risk: ${state.assessments[0]?.sgw_id ?? "—"}`,
  ] : [], [readiness.coverage, readiness.unassigned, state]);
  function selectStage(value: string) { setStage(value); setRight(value); setCurrentAdvisory(value); window.history.replaceState(null, "", `/leadership?t=${encodeURIComponent(value)}`); }
  async function createBriefing() { setBusy(true); setError(null); try { const response = await fetch(`${API}/api/briefings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advisory: stage }) }); if (!response.ok) throw new Error(); const next = await response.json() as Briefing; setBriefing(next); setDraft(next.text); } catch { setError("The grounded executive brief is temporarily unavailable."); } finally { setBusy(false); } }
  async function approveBriefing() { if (!briefing || !approver.trim() || !draft.trim()) return; setBusy(true); try { const response = await fetch(`${API}/api/briefings/${briefing.briefing_id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved_by: approver.trim(), final_text: draft.trim() }) }); if (!response.ok) throw new Error(); setBriefing(await response.json() as Briefing); } catch { setError("The brief could not be approved."); } finally { setBusy(false); } }

  return (
    <main className="ds-screen mx-auto w-full max-w-[1600px] px-5 pb-16 pt-6 md:px-8">
      <section className="panel rise flex flex-wrap items-center justify-between gap-5 p-6">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-11 w-1 rounded-full bg-[image:var(--gradient-ember)]" />
          <div>
            <p className="eyebrow-mono">Inform · Situation, decisions, readiness</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Leadership view</h1>
            <small className="text-xs text-muted-foreground">
              Hurricane Iris · {state?.advisory.stage ?? stage}{state ? ` · issued ${new Date(state.advisory.issued_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}.
              Leadership sees preparedness gaps, not workflow detail.
            </small>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="rounded-2xl border border-critical/45 bg-critical/10 px-4 py-3">
            <strong className="block font-display text-xl text-critical">Category {state?.advisory.storm_category ?? "—"}</strong>
            <small className="eyebrow-mono mt-1 block text-critical/80">Storm intensity</small>
          </div>
          <Link href={`/?t=${encodeURIComponent(stage)}&filter=critical`} className="press rounded-full border border-border bg-surface/70 px-4 py-2 text-sm font-medium hover:border-primary/40">View critical risks →</Link>
        </div>
      </section>

      {error ? <p className="panel mt-4 rounded-2xl border border-critical/40 bg-critical/10 px-4 py-3 text-xs text-critical">{error}</p> : null}

      <section className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Metric value={state?.summary.critical_assets} text="Critical assets" />
        <Metric value={state?.summary.high_assets} text="High assets" />
        <Metric value={state ? compact(state.summary.exposed_residents) : undefined} text="Residents exposed" />
        <Metric value={readiness.unassigned} text="Unassigned critical actions" warning={readiness.unassigned > 0} />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-5">
          <div className="panel rise p-6">
            <SectionHead eyebrow="Readiness" heading="Mitigation coverage" note={`${readiness.active} active · ${readiness.completed} completed`} />
            <div className="glass-chip flex flex-wrap items-center gap-4 rounded-2xl px-4 py-3.5">
              <strong className="font-display text-2xl">{readiness.coverage}%</strong>
              <div className="min-w-40 flex-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <span className="block h-full rounded-full bg-verified transition-[width] duration-500" style={{ width: `${readiness.coverage}%` }} />
                </div>
                <small className="mt-2 block text-[11px] text-muted-foreground">{readiness.coveredRisks} / {critical.length} critical risks fully owned</small>
              </div>
              <Link href={`/respond?t=${encodeURIComponent(stage)}`} className="text-xs font-medium text-primary hover:underline">Open response board →</Link>
            </div>

            <div className="mt-3 flex flex-col gap-2">
              {readiness.material.map((item) => (
                <Link key={item.recommendation_id} href={`/respond?t=${encodeURIComponent(stage)}&asset=${encodeURIComponent(item.asset_id)}`}
                  className="glass-chip press flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 hover:-translate-y-0.5">
                  <b className="text-sm font-medium">
                    <span className="font-mono text-[11px] text-muted-foreground">{item.asset_id.replace("SGW-", "")}</span> · {item.title}
                  </b>
                  <span className={`text-[11px] ${item.status === "recommended" ? "text-high" : "text-verified"}`}>
                    {item.status === "recommended" ? "Unassigned ⚠" : `${label(item.status)} · ${item.owner ?? "Operations"}`}
                  </span>
                </Link>
              ))}
              {!readiness.material.length ? <p className="text-xs text-muted-foreground">No critical actions raised at this advisory.</p> : null}
            </div>
          </div>

          <div className="panel rise p-6">
            <SectionHead eyebrow="Trajectory" heading="Advisory timeline" note="First advisory → landfall" />

            <div className="overflow-x-auto pb-1">
              <div className="relative min-w-[620px] px-3 pb-2 pt-7">
                <div className="relative h-1.5 rounded-full bg-surface-2">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-[image:var(--gradient-ember)] transition-[width] duration-500"
                    style={{ width: `${(STAGES.indexOf(stage) / Math.max(STAGES.length - 1, 1)) * 100}%` }} />
                </div>
                <div className="pointer-events-none absolute inset-x-3 top-0 flex justify-between">
                  <span className="eyebrow-mono text-[10px] text-muted-foreground">First advisory</span>
                  <span className="eyebrow-mono text-[10px] text-critical">Landfall</span>
                </div>

                <div className="mt-4 flex items-start justify-between gap-2">
                  {STAGES.map((item, index) => {
                    const entry = timeline[item];
                    const active = stage === item;
                    const previous = index > 0 ? timeline[STAGES[index - 1]] : undefined;
                    const delta = previous && entry ? entry.summary.critical_assets - previous.summary.critical_assets : 0;
                    return (
                      <button key={item} onClick={() => selectStage(item)} className="press group relative flex flex-1 flex-col items-center gap-2 text-center">
                        <span className={`absolute -top-[30px] h-4 w-4 rounded-full border-2 transition-all ${active ? "scale-125 border-primary bg-primary shadow-[0_0_0_6px_oklch(0.62_0.19_42/0.16)]" : "border-border bg-surface group-hover:border-primary/60"}`} />
                        <span className={`font-mono text-[11px] uppercase tracking-widest ${active ? "text-primary" : "text-muted-foreground"}`}>{stageLabel(item)}</span>
                        <span className={`glass-chip w-full rounded-2xl px-2 py-2.5 transition-all group-hover:-translate-y-0.5 ${active ? "border border-primary/50 bg-primary/10" : "border border-border"}`}>
                          <strong className="block font-display text-xl">{entry?.summary.critical_assets ?? "—"}</strong>
                          <small className="block text-[10px] text-muted-foreground">Critical</small>
                          <small className="mt-1 block text-[10px] text-muted-foreground">{entry ? compact(entry.summary.exposed_residents) : "…"} residents</small>
                          {delta !== 0 ? (
                            <small className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${delta > 0 ? "bg-critical/12 text-critical" : "bg-verified/12 text-verified"}`}>
                              {delta > 0 ? `▲ +${delta} critical` : `▼ ${Math.abs(delta)} recovered`}
                            </small>
                          ) : <small className="mt-1.5 inline-block text-[10px] text-muted-foreground">no change</small>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-border bg-surface-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="eyebrow-mono">Compare</span>
                <select value={left} onChange={(event) => setLeft(event.target.value)} aria-label="Compare from"
                  className="rounded-xl border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary/60">
                  {STAGES.map((item) => <option key={item} value={item}>{stageLabel(item)}</option>)}
                </select>
                <span className="text-muted-foreground">↔</span>
                <select value={right} onChange={(event) => setRight(event.target.value)} aria-label="Compare to"
                  className="rounded-xl border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary/60">
                  {STAGES.map((item) => <option key={item} value={item}>{stageLabel(item)}</option>)}
                </select>
                <small className={`ml-auto text-[11px] ${worsening ? "text-critical" : "text-verified"}`}>Situation {worsening ? "worsening" : "stable"}</small>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Delta text="Critical assets" from={before?.summary.critical_assets} to={after?.summary.critical_assets} />
                <Delta text="High assets" from={before?.summary.high_assets} to={after?.summary.high_assets} />
                <Delta text="Residents exposed" from={before ? compact(before.summary.exposed_residents) : undefined} to={after ? compact(after.summary.exposed_residents) : undefined} />
                <Delta text="Open actions" from={before?.summary.open_actions} to={after?.summary.open_actions} />
              </div>

              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Review structured deltas between advisories, not separate dashboards.</p>
            </div>

            {largestMover ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3">
                <strong className="text-sm">
                  Largest mover · {largestMover.item.sgw_id.replace("SGW-", "")}
                </strong>
                <span className="font-mono text-xs text-muted-foreground">
                  {largestMover.rankDelta === 0
                    ? `#${largestMover.item.rank} held`
                    : `#${largestMover.wasRank} → #${largestMover.item.rank} (${largestMover.rankDelta > 0 ? "+" : ""}${largestMover.rankDelta})`}
                  {" · risk "}
                  {largestMover.riskDelta > 0 ? "+" : ""}{largestMover.riskDelta.toFixed(1)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="flex flex-col gap-5">
          <div className="panel rise p-6">
            <div className="flex items-start justify-between gap-3">
              <div><p className="eyebrow-mono">Grounded executive brief</p><h2 className="mt-1 text-lg font-semibold">Draft, verify, approve</h2></div>
              {briefing ? (
                <span className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider ${briefing.status === "approved" ? "border-verified/50 bg-verified/10 text-verified" : "border-high/50 bg-high/10 text-high"}`}>{label(briefing.status)}</span>
              ) : null}
            </div>

            {!briefing ? (
              <div className="mt-4">
                <p className="text-xs leading-relaxed text-muted-foreground">Build a short executive update from a locked fact pack. Regeneration always creates a new draft.</p>
                <button onClick={() => void createBriefing()} disabled={busy} className="press mt-3 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "Preparing…" : "Generate draft brief"}</button>
              </div>
            ) : (
              <div className="mt-4">
                <small className="block text-[11px] text-verified">Grounded · {briefing.model} · v{briefing.version}</small>
                <small className="mt-1 block text-[11px] text-muted-foreground">Fact pack {briefing.fact_pack_sha256.slice(0, 16)} · source {briefing.advisory_id}</small>

                {briefing.status === "approved" ? (
                  <>
                    <p className="mt-3 whitespace-pre-line text-xs leading-relaxed">{briefing.final_text}</p>
                    <small className="mt-3 block text-[11px] text-verified">Approved by {briefing.approved_by}{briefing.approved_at ? ` · ${new Date(briefing.approved_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</small>
                  </>
                ) : (
                  <>
                    <label className="mt-3 block text-[11px] uppercase tracking-wider text-muted-foreground">Draft — awaiting approval
                      <textarea value={draft} maxLength={1200} rows={10} onChange={(event) => setDraft(event.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs normal-case leading-relaxed tracking-normal text-foreground outline-none focus:border-primary/60" />
                    </label>
                    <label className="mt-2 block text-[11px] uppercase tracking-wider text-muted-foreground">Approver name
                      <input value={approver} onChange={(event) => setApprover(event.target.value)} placeholder="Required to release"
                        className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm normal-case tracking-normal text-foreground outline-none focus:border-primary/60" />
                    </label>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button onClick={() => void createBriefing()} disabled={busy} className="press rounded-full border border-border bg-surface/70 px-4 py-2 text-sm disabled:opacity-50">Regenerate</button>
                      <button onClick={() => void approveBriefing()} disabled={busy || !approver.trim() || !draft.trim()}
                        className="press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">Approve</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="panel rise p-6">
            <p className="eyebrow-mono">Source facts</p>
            <div className="mt-3 flex flex-col gap-2">
              {sourceFacts.map((fact) => <span key={fact} className="glass-chip rounded-2xl px-3.5 py-2.5 text-xs">{fact}</span>)}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Metric({ value, text, warning = false }: { value: string | number | undefined; text: string; warning?: boolean }) {
  return (
    <div className="glass-chip press rounded-2xl px-4 py-3.5">
      <strong className={`block font-display text-2xl leading-none ${warning ? "text-high" : "text-foreground"}`}>{value ?? "—"}</strong>
      <small className="eyebrow-mono mt-2 block">{text}</small>
    </div>
  );
}

function SectionHead({ eyebrow, heading, note }: { eyebrow: string; heading: string; note?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><p className="eyebrow-mono">{eyebrow}</p><h2 className="mt-1 text-lg font-semibold">{heading}</h2></div>
      {note ? <small className="text-xs text-muted-foreground">{note}</small> : null}
    </div>
  );
}

function Delta({ text, from, to }: { text: string; from: string | number | undefined; to: string | number | undefined }) {
  return (
    <span className="glass-chip block rounded-2xl border-l-2 border-l-high px-3.5 py-2.5">
      <small className="block text-[11px] text-muted-foreground">{text}</small>
      <b className="mt-1 block text-sm">{from ?? "—"} → {to ?? "—"}</b>
    </span>
  );
}
