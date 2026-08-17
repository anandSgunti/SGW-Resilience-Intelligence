"use client";

import { useEffect, useMemo, useState } from "react";
import { useIncident } from "../IncidentContext";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type Lens = "infrastructure" | "consequence" | "confidence";
type Asset = { sgw_id: string; asset_type: string; name: string; condition_score: number; attributes: Record<string, string | number | boolean> };
type AssetState = { backup_available_hours: number | null; generator_status: string; verification_status: string; restoration_hours: number; flood_depth_m: number; wind_gust_kph: number; operational_status: string };
type Assessment = { sgw_id: string; disruption_likelihood: number; consequence_score: number; risk_score: number; tier: string; confidence: string; max_uncovered_hours: number; primary_change: string | null; confidence_reasons: string[]; verification_actions: string[]; current_drivers: Array<{ metric: string; label: string; value: string | number; unit: string | null; impact: string }> };
type NodeContext = { asset: Asset; state: AssetState; assessment: Assessment };
type Edge = { from_id: string; to_id: string; relationship: string; dependency_class: string; confidence: number; verified: boolean; source: string; last_validated: string; capacity_share: number | null; backup_endurance_hours: number | null };
type RecommendedAction = { recommendation_id: string; asset_id: string; target_asset_id: string | null; title: string; reason: string; priority: string; default_owner: string; status: string };
type DetailPayload = { advisory: { stage: string; issued_at: string }; asset: Asset; state: AssetState; assessment: Assessment; dependency_subgraph: { nodes: Asset[]; edges: Edge[] }; node_context: Record<string, NodeContext>; confidence_reasons: string[]; recommended_actions: RecommendedAction[] };
type ExplainPayload = { headline: string; answer: string; supporting_facts: Array<{ metric: string; label: string; value: string | number; unit: string | null }>; suggested_follow_up_questions: string[]; fact_pack_sha256: string; model: string; grounded: boolean };
type Point = { x: number; y: number };

const API_URL = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";

function compactId(value: string) { return value.replace("SGW-", ""); }
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function edgeLabel(value: string) { return value === "located_in" ? "critical service" : value.replaceAll("_", " "); }
function formatValue(value: string | number | null | undefined, unit = "") { return value === null || value === undefined || value === "" ? "—" : `${value}${unit}`; }


/* ---- confidence semantics -------------------------------------------------
   Confidence is not one quantity. A hospital's service record being well known
   says nothing about whether the pump feeding it has been checked. Naming the
   kind per asset type stops a chain of "High" reading as a high-confidence
   conclusion. */
const CONFIDENCE_KIND: Record<string, string> = {
  substation: "Assessment confidence",
  pump_station: "Operational confidence",
  water_zone: "Service data confidence",
};
function confidenceKind(assetType: string) {
  return CONFIDENCE_KIND[assetType] ?? "Service data confidence";
}
/** Topology links state a dependency; located_in states a service relationship. */
function edgeConfidenceKind(edge: Edge) {
  return edge.dependency_class === "service_consequence" || edge.relationship === "located_in"
    ? "Service relationship"
    : "Dependency confidence";
}
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
function band(score: number) { return score >= 0.85 ? "High" : score >= 0.6 ? "Medium" : "Low"; }
function confidenceTone(level: string) {
  const value = level.toLowerCase();
  return value === "high" ? "text-verified" : value === "medium" ? "text-uncertain" : value === "low" ? "text-critical" : "text-muted-foreground";
}
/** The path is only as trustworthy as its weakest evidence, so the headline
 *  reports the minimum and names what is holding it there. */
function pathConfidence(contexts: NodeContext[]) {
  if (!contexts.length) return { level: "Unknown", limiter: null as NodeContext | null };
  const weakest = contexts.reduce((worst, item) =>
    (CONFIDENCE_RANK[item.assessment.confidence] ?? 0) < (CONFIDENCE_RANK[worst.assessment.confidence] ?? 0) ? item : worst);
  const atWeakest = contexts.filter((item) => item.assessment.confidence === weakest.assessment.confidence);
  // Prefer an unverified node as the named limiter: that is the actionable gap.
  const limiter = atWeakest.find((item) => item.state.verification_status !== "verified") ?? weakest;
  const level = weakest.assessment.confidence;
  return { level: level.charAt(0).toUpperCase() + level.slice(1), limiter };
}

function graphLayout(nodes: Asset[], edges: Edge[]) {
  const ids = new Set(nodes.map((node) => node.sgw_id));
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of edges) if (ids.has(edge.from_id) && ids.has(edge.to_id)) { incoming.set(edge.to_id, (incoming.get(edge.to_id) ?? 0) + 1); outgoing.get(edge.from_id)?.push(edge.to_id); }
  const queue = [...ids].filter((id) => incoming.get(id) === 0).sort(); const depth = new Map([...ids].map((id) => [id, 0]));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    for (const child of outgoing.get(id) ?? []) { depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1)); incoming.set(child, (incoming.get(child) ?? 1) - 1); if (incoming.get(child) === 0) queue.push(child); }
  }
  const maxDepth = Math.max(1, ...depth.values()); const columns = new Map<number, string[]>();
  for (const node of nodes) { const level = depth.get(node.sgw_id) ?? 0; columns.set(level, [...(columns.get(level) ?? []), node.sgw_id]); }
  const result = new Map<string, Point>();
  for (const [level, column] of columns) column.sort().forEach((id, index) => result.set(id, { x: 9 + (level / maxDepth) * 82, y: 15 + ((index + 1) / (column.length + 1)) * 70 }));
  return result;
}
const tierColor: Record<string, string> = {
  critical: "text-critical border-critical/50 bg-critical/10",
  high: "text-high border-high/50 bg-high/10",
  medium: "text-medium border-medium/50 bg-medium/10",
  low: "text-verified border-verified/50 bg-verified/10",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="glass-chip press min-w-28 rounded-2xl px-5 py-4">
      <strong className={`block font-display text-2xl leading-none ${tone ?? "text-foreground"}`}>{value}</strong>
      <small className="eyebrow-mono mt-2 block">{label}</small>
    </div>
  );
}

function SectionTitle({ label, note }: { label: string; note?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-border pb-2">
      <span className="eyebrow-mono">{label}</span>
      {note ? <small className="text-xs text-muted-foreground">{note}</small> : null}
    </div>
  );
}

function NodeDetail({ context, edges, actions, stage, view }: { context: NodeContext; edges: Edge[]; actions: RecommendedAction[]; stage: string; view: "context" | "impact" | "evidence" }) {
  const [verificationPrepared, setVerificationPrepared] = useState(false);
  const { asset, state, assessment } = context;
  const incoming = edges.filter((edge) => edge.to_id === asset.sgw_id);
  const outgoing = edges.filter((edge) => edge.from_id === asset.sgw_id);
  const alternate = incoming.some((edge) => edge.relationship === "backup_feed");
  const supply = incoming.filter((edge) => edge.relationship === "serves").reduce((total, edge) => total + (edge.capacity_share ?? 0), 0);
  const relatedActions = actions.filter((action) => action.asset_id === asset.sgw_id || action.target_asset_id === asset.sgw_id);
  const evidenceReasons = assessment.confidence_reasons ?? [];

  let facts: Array<[string, string]>;
  if (asset.asset_type === "substation")
    facts = [["Restoration", `${state.restoration_hours}h`], ["Likelihood", `${Math.round(assessment.disruption_likelihood)}%`], ["Condition", `${asset.condition_score}/100`], ["Top driver", assessment.current_drivers[0]?.label ?? "—"]];
  else if (asset.asset_type === "pump_station")
    facts = [["Backup", formatValue(state.backup_available_hours, "h")], ["Alternate supply", alternate ? "Available" : "None modeled"], ["Generator", title(state.generator_status)], ["Resilience gap", `${assessment.max_uncovered_hours}h`]];
  else if (asset.asset_type === "water_zone")
    facts = [["Population", Number(asset.attributes.population ?? 0).toLocaleString("en-US")], ["Modeled coverage", supply ? `${Math.round(supply * 100)}%` : "—"], ["Incoming supplies", String(incoming.length)], ["Consequence", String(Math.round(assessment.consequence_score))]];
  else
    facts = [["Facility type", title(asset.asset_type)], ["Criticality", "Critical community service"], ["Risk tier", title(assessment.tier)], ["Confidence", title(assessment.confidence)]];

  const shell = "panel rise flex h-full flex-col gap-5 p-6 hover:-translate-y-0.5 hover:border-primary/25";

  if (view === "context") return (
    <div className={shell}>
      <div className="flex items-start gap-3">
        <span className="mt-1 h-9 w-1 rounded-full bg-[image:var(--gradient-ember)]" />
        <div>
          <p className="eyebrow-mono">Selected node</p>
          <h2 className="mt-1 text-lg font-semibold">{compactId(asset.sgw_id)} · {asset.name}</h2>
          <small className="text-xs text-muted-foreground">{title(asset.asset_type)} · {title(state.operational_status)}</small>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-widest ${tierColor[assessment.tier] ?? tierColor.medium}`}>{assessment.tier}</span>
        <strong className="font-display text-3xl">{Math.round(assessment.risk_score)}</strong>
        <small className="text-xs text-muted-foreground">systemic risk</small>
      </div>
      <section>
        <SectionTitle label="Operating context" note={title(state.verification_status)} />
        <div className="grid grid-cols-2 gap-3">
          {facts.map(([label, value]) => (
            <div key={label} className="glass-chip rounded-2xl px-3.5 py-2.5">
              <span className="block text-[11px] text-muted-foreground">{label}</span>
              <strong className="text-sm">{value}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  if (view === "impact") return (
    <div className={shell}>
      <span className="eyebrow-mono">Impact</span>
      <section>
        <SectionTitle label="Why it matters" />
        <p className="text-sm leading-relaxed text-muted-foreground">{assessment.primary_change ?? "No material advisory change recorded for this node."}</p>
      </section>
      <section>
        <SectionTitle label="Connected evidence" note={`${incoming.length + outgoing.length} links`} />
        <div className="flex flex-col gap-2">
          {[...incoming, ...outgoing].map((edge) => {
            const upstream = edge.to_id === asset.sgw_id;
            const trusted = edge.verified && edge.confidence >= 0.8;
            return (
              <div key={`${edge.from_id}-${edge.to_id}-${edge.relationship}`} className="glass-chip press flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5">
                <div>
                  <span className="block font-mono text-[11px] text-muted-foreground">{upstream ? "From" : "To"} {compactId(upstream ? edge.from_id : edge.to_id)}</span>
                  <strong className="text-sm">{title(edgeLabel(edge.relationship))}</strong>
                </div>
                <small className={`text-[11px] ${trusted ? "text-verified" : "text-uncertain"}`}>{trusted ? "Verified" : "Needs validation"} · {Math.round(edge.confidence * 100)}%</small>
              </div>
            );
          })}
          {!incoming.length && !outgoing.length ? <p className="text-sm text-muted-foreground">No modeled links for this node.</p> : null}
        </div>
      </section>
    </div>
  );

  return (
    <div className={shell}>
      <span className="eyebrow-mono">Evidence</span>
      <section>
        <SectionTitle label="Data confidence" note={title(assessment.confidence)} />
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          {evidenceReasons.slice(0, 2).map((reason) => <p key={reason}>{reason}</p>)}
          {!evidenceReasons.length ? <p>No material evidence exceptions recorded.</p> : null}
        </div>
        {assessment.verification_actions.length > 0 ? (
          <button type="button" onClick={() => setVerificationPrepared(true)} disabled={verificationPrepared}
            className="press mt-3 w-full rounded-full border border-primary/40 bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-60">
            {verificationPrepared ? "Verification handoff prepared" : "Create verification action"}
          </button>
        ) : null}
        {verificationPrepared ? (
          <small className="mt-2 block text-[11px] text-muted-foreground">No field work is auto-approved. <Link className="text-primary" href={`/respond?t=${encodeURIComponent(stage)}&asset=${encodeURIComponent(asset.sgw_id)}`}>Open the response desk →</Link></small>
        ) : null}
      </section>
      {relatedActions.length > 0 ? (
        <section>
          <SectionTitle label="Recommended response" note={`${relatedActions.length} open`} />
          <div className="flex flex-col gap-3">
            {relatedActions.slice(0, 2).map((action) => (
              <div key={action.recommendation_id} className="glass-chip rounded-2xl border-l-2 border-l-primary px-3.5 py-2.5">
                <strong className="text-sm">{action.title}</strong>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{action.reason}</p>
                <small className="mt-1 block font-mono text-[11px] text-muted-foreground">{action.default_owner} · {title(action.status)}</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AssetAsk({ context, stage, onClose }: { context: NodeContext; stage: string; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ExplainPayload | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const id = compactId(context.asset.sgw_id);
  const prompts = [
    `Why is ${id} ${title(context.assessment.tier)}?`,
    id === "S17" ? "Why is S17 above S31?" : `What drives ${id}'s ranking?`,
    "What changed since the previous advisory?",
    "What is uncertain?",
  ];
  async function ask(nextQuestion: string) {
    const trimmed = nextQuestion.trim(); if (!trimmed || asking) return;
    setQuestion(trimmed); setAsking(true); setAskError(null); setAnswer(null);
    try {
      const response = await fetch(`${API_URL}/api/explain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: trimmed, asset_id: context.asset.sgw_id, advisory: stage }) });
      if (!response.ok) throw new Error("Explanation unavailable");
      setAnswer(await response.json() as ExplainPayload);
    } catch { setAskError("The grounded answer is temporarily unavailable."); }
    finally { setAsking(false); }
  }
  return (
    <div className="panel flex h-[min(560px,70vh)] w-[min(400px,calc(100vw-2rem))] flex-col gap-4 p-5 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-start justify-between gap-3">
        <div><p className="eyebrow-mono">Grounded intelligence</p><h3 className="mt-1 text-lg font-semibold">Ask about {id}</h3></div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-verified/40 bg-verified/10 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-verified">Facts only</span>
          <button type="button" onClick={onClose} aria-label="Close chat" className="press grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground">✕</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => void ask(prompt)} className="glass-chip press rounded-full px-3.5 py-2 text-xs text-muted-foreground hover:text-foreground">{prompt}</button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
        <input aria-label={`Question about ${id}`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`Ask about ${id}…`} maxLength={500}
          className="glass-chip flex-1 rounded-full px-4 py-2.5 text-sm outline-none transition-shadow duration-300 focus:shadow-[0_0_0_4px_oklch(0.68_0.17_45/0.18)]" />
        <button type="submit" disabled={!question.trim() || asking} className="press rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{asking ? "Asking…" : "Ask"}</button>
      </form>
      <div aria-live="polite" className="glass-chip min-h-24 flex-1 overflow-y-auto rounded-2xl p-4">
        {asking ? <p className="text-sm text-muted-foreground">Building an answer from the locked fact pack…</p>
          : askError ? <p className="text-sm text-critical">{askError}</p>
          : answer ? (
            <>
              <strong className="block text-sm">{answer.headline}</strong>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{answer.answer}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {answer.supporting_facts.slice(0, 3).map((fact) => (
                  <span key={fact.metric} className="glass-chip rounded-xl px-3 py-2">
                    <small className="block text-[11px] text-muted-foreground">{fact.label}</small>
                    <strong className="text-sm">{formatValue(fact.value, fact.unit ?? "")}</strong>
                  </span>
                ))}
              </div>
              <small className="mt-3 block font-mono text-[11px] text-muted-foreground">Grounded · {answer.model} · Fact pack {answer.fact_pack_sha256.slice(0, 12)}</small>
            </>
          ) : <p className="text-sm text-muted-foreground">Answers are composed only from the locked advisory fact pack.</p>}
      </div>
    </div>
  );
}

export default function AssetRiskPage() {
  const { setCurrentAdvisory, setSelectedAsset } = useIncident();
  const searchParams = useSearchParams();
  const [assetId] = useState(() => searchParams?.get("asset") ?? "SGW-S17");
  const [stage] = useState(() => searchParams?.get("t") ?? "T-24");
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [focusedId, setFocusedId] = useState(() => searchParams?.get("asset") ?? "SGW-S17");
  const [lens, setLens] = useState<Lens>("infrastructure");
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set("t", stage); query.set("asset", focusedId);
    setCurrentAdvisory(stage); setSelectedAsset(focusedId);
    window.history.replaceState(null, "", `/asset-risk?${query.toString()}`);
  }, [focusedId, setCurrentAdvisory, setSelectedAsset, stage]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => { setLoading(true); setError(null); });
    fetch(`${API_URL}/api/assets/${encodeURIComponent(assetId)}?t=${encodeURIComponent(stage)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Asset detail unavailable"); return response.json() as Promise<DetailPayload>; })
      .then((payload) => { setDetail(payload); setFocusedId(payload.asset.sgw_id); })
      .catch((requestError: Error) => { if (requestError.name !== "AbortError") setError("The asset-risk state is unavailable."); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [assetId, stage]);

  useEffect(() => {
    if (!chatOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setChatOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  const positions = useMemo(() => graphLayout(detail?.dependency_subgraph.nodes ?? [], detail?.dependency_subgraph.edges ?? []), [detail]);
  const pathNodes = useMemo(() => Object.values(detail?.node_context ?? {}), [detail]);
  const overall = useMemo(() => pathConfidence(pathNodes), [pathNodes]);
  const focused = detail?.node_context[focusedId] ?? (detail ? { asset: detail.asset, state: detail.state, assessment: detail.assessment } : null);

  if (error) return (
    <main className="ds-screen mx-auto max-w-[1500px] px-6 py-8">
      <div className="panel rise p-8"><h1 className="text-xl font-semibold">Unable to load asset risk</h1><p className="mt-2 text-sm text-muted-foreground">{error}</p><Link className="mt-4 inline-block text-primary" href="/">Return to risk overview</Link></div>
    </main>
  );

  return (
    <main className="ds-screen mx-auto max-w-[1500px] px-6 py-8">
      <header className="panel rise flex flex-wrap items-end justify-between gap-6 p-8">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-primary/50 bg-primary/10 px-2.5 py-1 font-mono text-[11px] tracking-widest text-primary">{detail?.advisory.stage ?? stage}</span>
            <p className="eyebrow-mono">Why does this asset matter right now?</p>
          </div>
          <h1 className="mt-3 text-3xl font-semibold">{detail ? `${compactId(detail.asset.sgw_id)} · ${detail.asset.name}` : "Loading asset context"}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{detail?.assessment.primary_change ?? "Connecting to the current advisory state."}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Stat label="Likelihood" value={detail ? `${Math.round(detail.assessment.disruption_likelihood)}%` : "—"} />
          <Stat label="Consequence" value={detail ? String(Math.round(detail.assessment.consequence_score)) : "—"} />
          <Stat label={detail?.assessment.tier ?? "Risk"} value={detail ? String(Math.round(detail.assessment.risk_score)) : "—"} tone="text-critical" />
          <Stat label="Confidence" value={detail ? title(detail.assessment.confidence) : "—"} />
        </div>
      </header>

      <section className="panel rise mt-6 p-6 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="eyebrow-mono">Dependency intelligence</p><h2 className="mt-1 text-xl font-semibold">Connected impact path</h2></div>
          <div className="glass-chip flex gap-1 rounded-full p-1">
            {(["infrastructure", "consequence", "confidence"] as Lens[]).map((item) => (
              <button key={item} type="button" aria-pressed={lens === item} onClick={() => setLens(item)}
                className={`press rounded-full px-4 py-2 text-xs ${lens === item ? "bg-primary text-primary-foreground shadow-[0_8px_24px_-12px_oklch(0.68_0.17_45)]" : "text-muted-foreground hover:text-foreground"}`}>
                {title(item)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-surface-2/70 px-4 py-3">
          <div>
            <p className="text-sm font-semibold">
              Overall impact-path confidence: <span className={confidenceTone(overall.level)}>{overall.level}</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {overall.limiter
                ? `Limited by ${overall.limiter.state.verification_status === "verified" ? "" : "unverified "}${confidenceKind(overall.limiter.asset.asset_type).toLowerCase()} at ${compactId(overall.limiter.asset.sgw_id)}.`
                : "No modelled dependency path for this asset."}
            </p>
          </div>
          <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
            Dependencies are well understood. The conclusion sits at the weakest evidence on the path, not the strongest.
          </p>
        </div>

        <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {lens === "infrastructure" ? "Topology · redundancy · validated engineering relationships"
            : lens === "consequence" ? "Population · critical facilities · uncovered duration"
            : "Confidence is named per evidence type · the path inherits its weakest link"}
        </p>

        <div className={`grid-field relative mt-5 h-[460px] overflow-hidden rounded-[2rem] border border-border bg-surface-2/60 ${loading ? "opacity-70" : ""}`}>
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {(detail?.dependency_subgraph.edges ?? []).map((edge) => {
              const from = positions.get(edge.from_id); const to = positions.get(edge.to_id);
              if (!from || !to) return null;
              const uncertain = !edge.verified || edge.confidence < 0.8;
              const service = edge.dependency_class === "service_consequence" || edge.relationship === "located_in";
              const gap = (detail?.assessment.max_uncovered_hours ?? 0) > 0 && edge.from_id === detail?.asset.sgw_id;
              return (
                <line key={`${edge.from_id}-${edge.to_id}-${edge.relationship}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  vectorEffect="non-scaling-stroke" strokeWidth={gap ? 2.5 : 1.5} strokeDasharray={uncertain ? "5 5" : service ? "2 6" : "10 10"}
                  style={{ animation: "flow-dash 1.6s linear infinite" }}
                  stroke={gap ? "var(--critical)" : uncertain ? "var(--uncertain)" : service ? "var(--accent)" : "var(--verified)"}
                  opacity={lens === "confidence" && !uncertain ? 0.45 : 0.9} />
              );
            })}
          </svg>

          {(detail?.dependency_subgraph.nodes ?? []).map((node) => {
            const point = positions.get(node.sgw_id); const context = detail?.node_context[node.sgw_id];
            if (!point || !context) return null;
            const consequenceNode = node.asset_type === "water_zone" || !["substation", "pump_station"].includes(node.asset_type);
            const muted = lens === "consequence" && !consequenceNode;
            const focusedNode = focusedId === node.sgw_id;
            return (
              <button key={node.sgw_id} type="button" style={{ left: `${point.x}%`, top: `${point.y}%` }}
                onClick={() => setFocusedId(node.sgw_id)} onMouseEnter={() => setHoveredNode(node.sgw_id)} onMouseLeave={() => setHoveredNode(null)}
                onFocus={() => setHoveredNode(node.sgw_id)} onBlur={() => setHoveredNode(null)}
                className={`glass-chip absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-2xl px-4 py-3 text-left leading-tight duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] [transition-property:transform,opacity,box-shadow,border-color] hover:scale-[1.04] active:scale-95 ${focusedNode ? "scale-105 border-primary/60 shadow-[0_0_0_4px_oklch(0.68_0.17_45/0.18),0_20px_50px_-24px_oklch(0.68_0.17_45)]" : "hover:border-primary/40"} ${muted ? "opacity-35 saturate-50" : ""}`}>
                <span className="flex items-center gap-2">
                  <i className={`h-2 w-2 rounded-full ${context.assessment.tier === "critical" ? "bg-critical" : context.assessment.tier === "high" ? "bg-high" : "bg-medium"}`} />
                  <span className="font-display text-sm font-semibold">{compactId(node.sgw_id)}</span>
                </span>
                <small className="mt-1 block text-[11px] text-muted-foreground">{title(node.asset_type)}</small>
                {lens === "consequence" && node.asset_type === "water_zone" ? <b className="mt-1 block text-[11px] text-accent">{Number(node.attributes.population ?? 0).toLocaleString("en-US")} residents</b> : null}
                {lens === "confidence" ? (
                  <b className="mt-1 block max-w-[190px] whitespace-normal text-[11px] font-medium leading-tight">
                    <span className="text-muted-foreground">{confidenceKind(node.asset_type)}: </span>
                    <span className={confidenceTone(context.assessment.confidence)}>{title(context.assessment.confidence)}</span>
                  </b>
                ) : null}
              </button>
            );
          })}

          {/* Edge confidence sits on the link, not only on the nodes. */}
          {lens === "confidence" ? (detail?.dependency_subgraph.edges ?? []).map((edge) => {
            const from = positions.get(edge.from_id); const to = positions.get(edge.to_id);
            if (!from || !to) return null;
            const level = band(edge.confidence);
            return (
              <span key={`label-${edge.from_id}-${edge.to_id}-${edge.relationship}`}
                style={{ left: `${(from.x + to.x) / 2}%`, top: `${(from.y + to.y) / 2}%` }}
                className="glass-chip pointer-events-none absolute z-[5] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] leading-none">
                <span className="text-muted-foreground">{edgeConfidenceKind(edge)}: </span>
                <span className={confidenceTone(level)}>{level}</span>
              </span>
            );
          }) : null}

          {hoveredNode && detail?.node_context[hoveredNode] ? (() => {
            const context = detail.node_context[hoveredNode]; const point = positions.get(hoveredNode)!;
            return (
              <div style={{ left: `${point.x}%`, top: `${point.y}%` }} className="panel pointer-events-none absolute z-10 w-56 -translate-x-1/2 translate-y-10 rounded-2xl p-3.5 text-xs">
                <strong className="block">{compactId(hoveredNode)} · {title(context.asset.asset_type)}</strong>
                <span className="mt-1 block text-muted-foreground">Risk {Math.round(context.assessment.risk_score)} · {title(context.assessment.tier)}</span>
                <span className="block text-muted-foreground">{confidenceKind(context.asset.asset_type)}: <span className={confidenceTone(context.assessment.confidence)}>{title(context.assessment.confidence)}</span></span>
              </div>
            );
          })() : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          <span className="flex items-center gap-2"><i className="h-0.5 w-6 bg-verified" />Validated dependency</span>
          <span className="flex items-center gap-2"><i className="h-0.5 w-6 bg-accent" />Service consequence</span>
          <span className="flex items-center gap-2"><i className="h-0.5 w-6 bg-uncertain" />Unverified</span>
          <span className="flex items-center gap-2"><i className="h-1 w-6 bg-critical" />Material resilience gap</span>
          {lens === "confidence" ? <span className="flex items-center gap-2 normal-case tracking-normal">Node colour stays asset risk tier; confidence is stated in words.</span> : null}
        </div>
      </section>

      <section className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {focused ? <>
          <NodeDetail key={`ctx-${focusedId}`} context={focused} edges={detail?.dependency_subgraph.edges ?? []} actions={detail?.recommended_actions ?? []} stage={stage} view="context" />
          <NodeDetail key={`imp-${focusedId}`} context={focused} edges={detail?.dependency_subgraph.edges ?? []} actions={detail?.recommended_actions ?? []} stage={stage} view="impact" />
          <NodeDetail key={`ev-${focusedId}`} context={focused} edges={detail?.dependency_subgraph.edges ?? []} actions={detail?.recommended_actions ?? []} stage={stage} view="evidence" />
        </> : <div className="panel p-6 text-sm text-muted-foreground">Choose a node in the dependency map to inspect its evidence.</div>}
      </section>

      {/* Grounded intelligence is a docked chat rather than a fourth column, so
          the evidence panes keep the full width. */}
      {focused ? (
        <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3">
          {chatOpen ? <AssetAsk key={`ask-${focusedId}`} context={focused} stage={stage} onClose={() => setChatOpen(false)} /> : null}
          <button type="button" onClick={() => setChatOpen((open) => !open)} aria-expanded={chatOpen}
            aria-label={chatOpen ? "Close grounded intelligence" : `Ask about ${compactId(focusedId)}`}
            className="press flex items-center gap-2.5 rounded-full bg-primary px-5 py-3.5 text-sm font-medium text-primary-foreground shadow-[0_18px_40px_-18px_oklch(0.62_0.19_42)] hover:opacity-95">
            <span aria-hidden="true" className="text-base leading-none">{chatOpen ? "✕" : "✦"}</span>
            {chatOpen ? "Close" : `Ask about ${compactId(focusedId)}`}
          </button>
        </div>
      ) : null}
    </main>
  );
}
