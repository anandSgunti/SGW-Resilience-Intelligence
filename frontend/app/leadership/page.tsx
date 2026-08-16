"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useIncident } from "../IncidentContext";
import Link from "next/link";

type Assessment = { sgw_id: string; tier: string; rank: number; risk_score: number; affected_population: number; primary_change: string | null; confidence?: { level: string; reasons: string[] } };
type Response = { recommendation_id: string; asset_id: string; title: string; priority: string; status: string; owner: string | null };
type State = { advisory: { stage: string; advisory_id: string; issued_at: string; storm_category: number; data_freshness_minutes: { weather: number; field_ops: number; maintenance: number } }; summary: { critical_assets: number; high_assets: number; exposed_residents: number; open_actions: number }; assessments: Assessment[]; responses: Response[] };
type Briefing = { briefing_id: string; advisory_id: string; version: number; text: string; fact_pack_sha256: string; model: string; status: string; created_at: string | null; approved_by: string | null; approved_at: string | null; final_text: string | null };
const API = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";
// These are backend advisory stages, not display aliases. The final event
// stage is `Landfall`; using `T-0` would 404 and invalidate the full timeline.
const STAGES = ["T-72", "T-48", "T-24", "T-12", "Landfall"];
const compact = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const isProgressed = (status: string) => ["approved", "assigned", "in_progress", "completed"].includes(status);

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
    const assignedRisks = new Set(actions.filter((item) => isProgressed(item.status)).map((item) => item.asset_id)).size;
    const material = [...actions].sort((a, b) => Number(b.priority === "critical") - Number(a.priority === "critical") || a.asset_id.localeCompare(b.asset_id)).slice(0, 3);
    return { assignedRisks, actions, material, active: actions.filter((item) => item.status === "in_progress").length, completed: actions.filter((item) => item.status === "completed").length, unassigned: actions.filter((item) => item.status === "recommended").length, coverage: critical.length ? Math.round((assignedRisks / critical.length) * 100) : 0 };
  }, [critical, state]);
  const compare = useMemo(() => ({ before: timeline[left], after: timeline[right] }), [left, right, timeline]);
  const largestMover = useMemo(() => compare.after?.assessments.find((item) => item.primary_change) ?? null, [compare.after]);
  const sourceFacts = useMemo(() => state ? [
    `Advisory ${state.advisory.stage} · ${state.advisory.issued_at}`, `${state.summary.critical_assets} Critical · ${state.summary.high_assets} High`,
    `${compact(state.summary.exposed_residents)} residents exposed`, `${readiness.coverage}% mitigation coverage`,
    `Unresolved critical actions: ${readiness.unassigned}`, `Top systemic risk: ${state.assessments[0]?.sgw_id ?? "—"}`,
  ] : [], [readiness.coverage, readiness.unassigned, state]);
  function selectStage(value: string) { setStage(value); setRight(value); setCurrentAdvisory(value); window.history.replaceState(null, "", `/leadership?t=${encodeURIComponent(value)}`); }
  async function createBriefing() { setBusy(true); setError(null); try { const response = await fetch(`${API}/api/briefings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advisory: stage }) }); if (!response.ok) throw new Error(); const next = await response.json() as Briefing; setBriefing(next); setDraft(next.text); } catch { setError("The grounded executive brief is temporarily unavailable."); } finally { setBusy(false); } }
  async function approveBriefing() { if (!briefing || !approver.trim() || !draft.trim()) return; setBusy(true); try { const response = await fetch(`${API}/api/briefings/${briefing.briefing_id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved_by: approver.trim(), final_text: draft.trim() }) }); if (!response.ok) throw new Error(); setBriefing(await response.json() as Briefing); } catch { setError("The brief could not be approved."); } finally { setBusy(false); } }

  return <main className="shell"><style>{css}</style>
    <header><Link href="/">← Risk overview</Link><div><small>SOUTHEASTERN GRID &amp; WATER</small><strong>Leadership view</strong></div><span>Hurricane Iris · {state?.advisory.stage ?? stage}</span></header>
    <section className="hero"><div><small>INFORM</small><h1>Situation, decisions, readiness</h1><p>Leadership sees preparedness gaps, not workflow detail.</p></div><div style={{ display: "flex", alignItems: "center", gap: 9 }}><b>Category {state?.advisory.storm_category ?? "—"}</b><a href={`/?t=${encodeURIComponent(stage)}&filter=critical`} style={{ padding: 10, border: "1px solid #3d6088", color: "#69a9ff", textDecoration: "none", font: "8px monospace" }}>View critical risks →</a></div></section>
    {error && <p className="error">{error}</p>}
    <section className="kpis"><Metric value={state?.summary.critical_assets} text="Critical risks" /><Metric value={state?.summary.high_assets} text="High risks" /><Metric value={state ? compact(state.summary.exposed_residents) : undefined} text="Residents exposed" /><Metric value={`${readiness.coverage}%`} text="Mitigation coverage" /></section>
    <section className="content"><div className="main">
      <SectionHead eyebrow="6D.2 · Response readiness" title="Are the biggest risks being managed?" href={`/respond?t=${stage}`} />
      <div className="readiness"><Metric value={`${readiness.assignedRisks} / ${critical.length}`} text="Critical risks with mitigation assigned" /><Metric value={readiness.active} text="Critical actions in progress" /><Metric value={readiness.completed} text="Critical actions completed" /><Metric value={readiness.unassigned} text="Unassigned critical actions" warning={readiness.unassigned > 0} /></div>
      <div className="coverage"><span>Mitigation coverage</span><strong>{readiness.coverage}%</strong><i><em style={{ width: `${readiness.coverage}%` }} /></i><a href={`/respond?t=${stage}`}>Open Response Board →</a></div>
      <div className="actions">{readiness.material.map((item) => <a key={item.recommendation_id} href={`/respond?t=${stage}&asset=${item.asset_id}`}><b>{item.asset_id.replace("SGW-", "")} · {item.title}</b><span className={item.status === "recommended" ? "warn" : ""}>{item.status === "recommended" ? "UNASSIGNED ⚠" : `${label(item.status)} · ${item.owner ?? "Operations"}`}</span></a>)}</div>
      <SectionHead eyebrow="6D.4 · Event trajectory" title="Is the situation getting better or worse?" />
      <div className="trajectory">{STAGES.map((item) => <button onClick={() => selectStage(item)} className={stage === item ? "active" : ""} key={item}><b>{item}</b><strong>{timeline[item]?.summary.critical_assets ?? "—"}</strong><span>Critical</span><small>{timeline[item] ? compact(timeline[item].summary.exposed_residents) : "…"} residents</small></button>)}</div>
      <div className="compare"><div><label>Compare <select value={left} onChange={(event) => setLeft(event.target.value)}>{STAGES.map((item) => <option key={item}>{item}</option>)}</select> ↔ <select value={right} onChange={(event) => setRight(event.target.value)}>{STAGES.map((item) => <option key={item}>{item}</option>)}</select></label><p>Situation {compare.after && compare.before && compare.after.summary.critical_assets > compare.before.summary.critical_assets ? "worsening" : "stable"}: review structured deltas, not separate dashboards.</p></div><div className="deltas"><Delta label="Critical assets" from={compare.before?.summary.critical_assets} to={compare.after?.summary.critical_assets} /><Delta label="Residents exposed" from={compare.before ? compact(compare.before.summary.exposed_residents) : undefined} to={compare.after ? compact(compare.after.summary.exposed_residents) : undefined} /><Delta label="Open actions" from={compare.before?.summary.open_actions} to={compare.after?.summary.open_actions} /><Delta label="Mitigation coverage" from="—" to={right === stage ? `${readiness.coverage}%` : "—"} /></div></div>
      {largestMover && <div className="mover"><b>Largest mover · {largestMover.sgw_id.replace("SGW-", "")}</b><span>#{largestMover.rank} · {largestMover.primary_change ?? "Current advisory change"}</span></div>}
    </div><aside>
      <div className="brief-head"><small>6D.3 · Grounded executive brief</small><h2>Draft, verify, approve</h2>{briefing && <span className={briefing.status}>{label(briefing.status)}</span>}</div>
      {!briefing ? <div className="brief-body"><p>Build a short executive update from a locked fact pack. Regeneration always creates a new draft.</p><button onClick={() => void createBriefing()} disabled={busy}>{busy ? "Preparing…" : "Generate draft brief"}</button></div> : <div className="brief-body"><p className="provenance">Grounded · {briefing.model} · v{briefing.version}<br />Fact pack {briefing.fact_pack_sha256.slice(0, 12)} · source {briefing.advisory_id}</p>{briefing.status === "approved" ? <><p className="final">{briefing.final_text}</p><small>Approved by {briefing.approved_by} · {briefing.approved_at && new Date(briefing.approved_at).toLocaleString()}</small></> : <><label>Draft — awaiting approval<textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1200} /></label><label>Approver name<input value={approver} onChange={(event) => setApprover(event.target.value)} /></label><div className="buttons"><button onClick={() => void createBriefing()} disabled={busy}>Regenerate</button><button onClick={() => void approveBriefing()} disabled={busy || !approver.trim() || !draft.trim()}>Approve</button></div></>}</div>}
      <div className="facts"><small>SOURCE FACTS</small>{sourceFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>
    </aside></section>
  </main>;
}

function Metric({ value, text, warning = false }: { value: string | number | undefined; text: string; warning?: boolean }) { return <div className={warning ? "metric warning" : "metric"}><strong>{value ?? "—"}</strong><span>{text}</span></div>; }
function SectionHead({ eyebrow, title, href }: { eyebrow: string; title: string; href?: string }) { return <div className="section-head"><div><small>{eyebrow}</small><h2>{title}</h2></div>{href && <a href={href}>Response Board →</a>}</div>; }
function Delta({ label: text, from, to }: { label: string; from: string | number | undefined; to: string | number | undefined }) { return <span><small>{text}</small><b>{from ?? "—"} → {to ?? "—"}</b></span>; }

const css = `.shell{min-height:100vh;background:#090d0d;color:#f2f4f3;font:12px Arial,sans-serif}.shell *{box-sizing:border-box}header{height:66px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 28px;border-bottom:1px solid #27302f}header a,header span,.section-head a{color:#8c9795;text-decoration:none;font:10px monospace}header div{text-align:center}header div small,.section-head small,.hero small,.brief-head small,.facts small{display:block;color:#8c9795;letter-spacing:.13em;font:600 9px monospace}header div strong{display:block;margin-top:4px}.hero{display:flex;justify-content:space-between;align-items:center;padding:24px 28px;border-bottom:1px solid #27302f;background:#0b1010}.hero h1{margin:7px 0;font-size:24px}.hero p{margin:0;color:#8c9795}.hero b{padding:14px;border:1px solid #653b39;color:#ff665f;font:600 16px monospace}.error{margin:15px;padding:10px;border:1px solid #793f3d;color:#ff665f}.kpis,.readiness{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #27302f}.metric{min-height:80px;padding:15px 20px;border-right:1px solid #27302f}.metric strong{display:block;font:600 21px monospace}.metric span{display:block;margin-top:6px;color:#8c9795;text-transform:uppercase;font-size:8px;letter-spacing:.07em}.metric.warning strong{color:#f4aa4e}.content{display:grid;grid-template-columns:minmax(0,1fr) 390px}.main{padding:25px 28px;border-right:1px solid #27302f}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:15px}.section-head h2,.brief-head h2{margin:6px 0 0;font-size:16px}.section-head a{color:#69a9ff}.readiness{border:1px solid #27302f}.coverage{display:flex;align-items:center;gap:12px;margin:12px 0;padding:11px 13px;border:1px solid #3a4544}.coverage span{color:#8c9795;font-size:9px}.coverage strong{font:600 16px monospace}.coverage i{height:5px;flex:1;background:#26302f}.coverage em{display:block;height:100%;background:#5dd39e}.coverage a{color:#69a9ff;text-decoration:none;font:9px monospace}.actions{border:1px solid #27302f}.actions a{display:flex;justify-content:space-between;gap:12px;padding:12px;border-bottom:1px solid #27302f;color:#f2f4f3;text-decoration:none}.actions a:last-child{border-bottom:0}.actions b{font-size:10px}.actions span{color:#5dd39e;font:8px monospace}.actions .warn{color:#f4aa4e}.trajectory{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #27302f}.trajectory button{padding:12px;border:0;border-right:1px solid #27302f;background:#0b1010;color:#f2f4f3;text-align:left;cursor:pointer}.trajectory button.active{box-shadow:inset 0 2px #69a9ff;background:#131919}.trajectory button strong,.trajectory button span,.trajectory button small{display:block}.trajectory button strong{margin:8px 0 3px;font:600 18px monospace}.trajectory button span,.trajectory button small{color:#8c9795;font-size:8px}.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px;padding:13px;border:1px solid #27302f}.compare label{font:600 9px monospace}.compare select{margin:0 4px;border:1px solid #3a4544;background:#0b1010;color:#f2f4f3;padding:4px}.compare p{color:#8c9795;font-size:9px;line-height:1.5}.deltas{display:grid;grid-template-columns:1fr 1fr;gap:9px}.deltas span{padding:7px;border-left:2px solid #f4aa4e}.deltas small,.deltas b{display:block}.deltas small{color:#8c9795;font-size:7px}.deltas b{margin-top:3px;font:9px monospace}.mover{display:flex;justify-content:space-between;margin-top:12px;padding:11px;border:1px solid #3d6088}.mover span{color:#8c9795;font-size:9px}aside{background:#0a0f0f}.brief-head{position:relative;padding:22px 20px;border-bottom:1px solid #27302f}.brief-head>span{position:absolute;right:20px;top:22px;padding:4px 6px;border:1px solid #f4aa4e;color:#f4aa4e;font:7px monospace;text-transform:uppercase}.brief-head>span.approved{border-color:#5dd39e;color:#5dd39e}.brief-body,.facts{padding:20px}.brief-body p{color:#aeb7b5;font-size:10px;line-height:1.55}.brief-body button{padding:9px 10px;border:1px solid #3d6088;background:#10202b;color:#69a9ff;font:8px monospace;cursor:pointer}.brief-body label{display:block;margin-top:12px;color:#8c9795;font:8px monospace;text-transform:uppercase}.brief-body textarea,.brief-body input{width:100%;margin-top:6px;padding:8px;border:1px solid #3a4544;background:#0b1010;color:#f2f4f3;font:10px Arial}.brief-body textarea{min-height:130px;resize:vertical}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.provenance{color:#5dd39e!important;font:8px monospace}.final{color:#d5dcda!important}.facts{border-top:1px solid #27302f}.facts span{display:block;margin-top:8px;color:#aeb7b5;font-size:9px}@media(max-width:850px){.content{grid-template-columns:1fr}.main{border-right:0}.kpis,.readiness{grid-template-columns:repeat(2,1fr)}}@media(max-width:550px){header{grid-template-columns:1fr auto}header div{display:none}.hero{padding:18px}.trajectory{grid-template-columns:1fr}.trajectory button{border-bottom:1px solid #27302f}.compare{grid-template-columns:1fr}.actions a,.mover{flex-direction:column}.coverage{align-items:flex-start;flex-wrap:wrap}}`;
