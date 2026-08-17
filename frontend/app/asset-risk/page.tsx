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

function NodeDetail({ context, edges, actions, stage }: { context: NodeContext; edges: Edge[]; actions: RecommendedAction[]; stage: string }) {
  const [verificationPrepared, setVerificationPrepared] = useState(false);
  const { asset, state, assessment } = context; const incoming = edges.filter((edge) => edge.to_id === asset.sgw_id); const outgoing = edges.filter((edge) => edge.from_id === asset.sgw_id);
  const alternate = incoming.some((edge) => edge.relationship === "backup_feed");
  const supply = incoming.filter((edge) => edge.relationship === "serves").reduce((total, edge) => total + (edge.capacity_share ?? 0), 0);
  const relatedActions = actions.filter((action) => action.asset_id === asset.sgw_id || action.target_asset_id === asset.sgw_id);
  const evidenceGaps = assessment.verification_actions ?? [];
  const evidenceReasons = assessment.confidence_reasons ?? [];
  let facts: Array<[string, string]>;
  if (asset.asset_type === "substation") facts = [["Restoration", `${state.restoration_hours}h`], ["Likelihood", `${Math.round(assessment.disruption_likelihood)}%`], ["Condition", `${asset.condition_score}/100`], ["Top driver", assessment.current_drivers[0]?.label ?? "—"]];
  else if (asset.asset_type === "pump_station") facts = [["Backup", formatValue(state.backup_available_hours, "h")], ["Alternate supply", alternate ? "Available" : "None modeled"], ["Generator", title(state.generator_status)], ["Resilience gap", `${assessment.max_uncovered_hours}h`]];
  else if (asset.asset_type === "water_zone") facts = [["Population", Number(asset.attributes.population ?? 0).toLocaleString("en-US")], ["Modeled coverage", supply ? `${Math.round(supply * 100)}%` : "—"], ["Incoming supplies", String(incoming.length)], ["Consequence", String(Math.round(assessment.consequence_score))]];
  else facts = [["Facility type", title(asset.asset_type)], ["Criticality", "Critical community service"], ["Risk tier", title(assessment.tier)], ["Confidence", title(assessment.confidence)]];
  return <div className="node-detail">
    <div className="node-detail-heading"><span className={`node-type-mark node-type-mark--${asset.asset_type}`} /><div><p className="eyebrow">Selected node</p><h2>{compactId(asset.sgw_id)} · {asset.name}</h2><small>{title(asset.asset_type)} · {title(state.operational_status ?? "operational")}</small></div></div>
    <div className="detail-tier"><span className={`tier-pill tier-pill--${assessment.tier}`}>{assessment.tier}</span><strong>{Math.round(assessment.risk_score)}</strong><small>systemic risk</small></div>
    <section className="detail-section"><div className="detail-section-title"><span>Operating context</span><small>{title(state.verification_status)}</small></div><div className="node-facts">{facts.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section>
    <section className="detail-section detail-driver"><div className="detail-section-title"><span>Why it matters</span></div><p>{assessment.primary_change ?? assessment.current_drivers[0]?.impact?.replaceAll("_", " ") ?? "No material advisory change recorded for this node."}</p></section>
    <section className="detail-section"><div className="detail-section-title"><span>Connected evidence</span><small>{incoming.length + outgoing.length} links</small></div><div className="connection-list">{[...incoming, ...outgoing].length ? [...incoming, ...outgoing].map((edge) => { const upstream = edge.to_id === asset.sgw_id; return <div key={`${edge.from_id}-${edge.to_id}-${edge.relationship}`}><span>{upstream ? "From" : "To"} {compactId(upstream ? edge.from_id : edge.to_id)}</span><strong>{title(edgeLabel(edge.relationship))}</strong><small className={edge.verified && edge.confidence >= .8 ? "evidence-verified" : "evidence-uncertain"}>{edge.verified && edge.confidence >= .8 ? "Verified" : "Needs validation"} · {Math.round(edge.confidence * 100)}%</small></div>; }) : <p className="empty-detail">No modeled links for this node.</p>}</div></section>
    <section className="detail-section confidence-block"><div className="detail-section-title"><span>Data confidence</span><strong className={`confidence-label confidence-label--${assessment.confidence}`}>{title(assessment.confidence)}</strong></div>{evidenceReasons.slice(0, 2).map((reason) => <p key={reason}>{reason}</p>)}{!evidenceReasons.length && <p>No material evidence exceptions recorded.</p>}{evidenceGaps.length > 0 && <button type="button" className="verification-action" onClick={() => setVerificationPrepared(true)} disabled={verificationPrepared}>{verificationPrepared ? "Verification handoff prepared" : "Create verification action"}</button>}{verificationPrepared && <small className="handoff-note">No field work is auto-approved. <a href={`/respond?t=${encodeURIComponent(stage)}&asset=${encodeURIComponent(asset.sgw_id)}`}>Open Respond queue →</a></small>}</section>
    {relatedActions.length > 0 && <section className="detail-section response-preview"><div className="detail-section-title"><span>Recommended response</span><small>{relatedActions.length} open</small></div>{relatedActions.slice(0, 2).map((action) => <div key={action.recommendation_id}><strong>{action.title}</strong><p>{action.reason}</p><small>{action.default_owner} · {title(action.status)}</small></div>)}</section>}
  </div>;
}

function AssetAsk({ context, stage }: { context: NodeContext; stage: string }) {
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
  return <section className="asset-ask">
    <div className="asset-ask-heading"><div><p className="eyebrow">Grounded intelligence</p><h3>Ask about this asset</h3></div><span>Facts only</span></div>
    <div className="ask-prompts">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => void ask(prompt)}>{prompt}</button>)}</div>
    <form className="ask-composer" onSubmit={(event) => { event.preventDefault(); void ask(question); }}><label htmlFor={`asset-question-${id}`}>Question about {id}</label><div><input id={`asset-question-${id}`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`Ask about ${id}…`} maxLength={500} /><button type="submit" disabled={!question.trim() || asking}>{asking ? "Checking…" : "Ask"}</button></div></form>
    <div className="ask-result" aria-live="polite">{asking && <p className="ask-status">Building an answer from the locked fact pack…</p>}{askError && <p className="ask-error">{askError}</p>}{answer && <><div className="ask-answer-meta"><span className="grounded-badge">Grounded · {answer.model}</span><small>Fact pack {answer.fact_pack_sha256.slice(0, 10)}</small></div><strong>{answer.headline}</strong><p>{answer.answer}</p>{answer.supporting_facts.length > 0 && <div className="ask-facts">{answer.supporting_facts.slice(0, 3).map((fact) => <span key={fact.metric}><small>{fact.label}</small><strong>{formatValue(fact.value, fact.unit ?? "")}</strong></span>)}</div>}</>}</div>
  </section>;
}

export default function AssetRiskPage() {
  const { setCurrentAdvisory, setSelectedAsset } = useIncident();
  const searchParams = useSearchParams();
  // Seeded from the URL during render so the server and client agree; no
  // effect writes this state back on mount.
  const [assetId] = useState(() => searchParams?.get("asset") ?? "SGW-S17");
  const [stage] = useState(() => searchParams?.get("t") ?? "T-24");
  const [detail, setDetail] = useState<DetailPayload | null>(null); const [focusedId, setFocusedId] = useState(() => searchParams?.get("asset") ?? "SGW-S17");
  const [lens, setLens] = useState<Lens>("infrastructure"); const [hoveredNode, setHoveredNode] = useState<string | null>(null); const [hoveredEdge, setHoveredEdge] = useState<Edge | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  useEffect(() => { const query = new URLSearchParams(window.location.search); query.set("t", stage); query.set("asset", focusedId); setCurrentAdvisory(stage); setSelectedAsset(focusedId); window.history.replaceState(null, "", `/asset-risk?${query.toString()}`); }, [focusedId, setCurrentAdvisory, setSelectedAsset, stage]);
  useEffect(() => { const controller = new AbortController(); void Promise.resolve().then(() => { setLoading(true); setError(null); }); fetch(`${API_URL}/api/assets/${encodeURIComponent(assetId)}?t=${encodeURIComponent(stage)}`, { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Asset detail unavailable"); return response.json() as Promise<DetailPayload>; }).then((payload) => { setDetail(payload); setFocusedId(payload.asset.sgw_id); }).catch((requestError: Error) => { if (requestError.name !== "AbortError") setError("The asset-risk state is unavailable."); }).finally(() => setLoading(false)); return () => controller.abort(); }, [assetId, stage]);
  const positions = useMemo(() => graphLayout(detail?.dependency_subgraph.nodes ?? [], detail?.dependency_subgraph.edges ?? []), [detail]);
  const focused = detail?.node_context[focusedId] ?? (detail ? { asset: detail.asset, state: detail.state, assessment: detail.assessment } : null);

  return <main className="asset-risk-shell">
    {error ? <div className="asset-risk-error"><strong>Unable to load asset risk</strong><p>{error}</p><Link href="/">Return to risk overview</Link></div> : <>
      <nav className="ribbon" aria-label="Asset risk summary">
        <div className="ribbon-track" role="group" aria-label="Advisory stage"><span className="ribbon-step ribbon-step--active">{detail?.advisory.stage ?? stage}</span></div>
        <div className="ribbon-title"><p className="ribbon-kicker">Why does this asset matter right now?</p>
          <h1>{detail ? `${compactId(detail.asset.sgw_id)} · ${detail.asset.name}` : "Loading asset context"}</h1></div>
        <div className="ribbon-summary">
          <div className="ribbon-kpi"><strong>{detail ? `${Math.round(detail.assessment.disruption_likelihood)}%` : "—"}</strong><small>Likelihood</small></div>
          <div className="ribbon-kpi"><strong>{detail ? Math.round(detail.assessment.consequence_score) : "—"}</strong><small>Consequence</small></div>
          <div className={`ribbon-kpi ribbon-kpi--${detail?.assessment.tier ?? "medium"}`}><strong>{detail ? Math.round(detail.assessment.risk_score) : "—"}</strong><small>{detail?.assessment.tier ?? "Risk"}</small></div>
          <div className="ribbon-kpi"><strong>{detail ? title(detail.assessment.confidence) : "—"}</strong><small>Confidence</small></div>
        </div>
      </nav>
      <p className="asset-lede">{detail?.assessment.primary_change ?? "Connecting to the current advisory state."}</p>
      <section className="asset-risk-workspace">
        <div className="graph-panel"><div className="graph-toolbar"><div><p className="eyebrow">Dependency intelligence</p><h2>Connected impact path</h2></div><div className="lens-switch" aria-label="Graph lens">{(["infrastructure", "consequence", "confidence"] as Lens[]).map((item) => <button key={item} className={lens === item ? "lens-button lens-button--active" : "lens-button"} onClick={() => setLens(item)} aria-pressed={lens === item}>{title(item)}</button>)}</div></div>
          <div className={`dependency-graph dependency-graph--${lens}${loading ? " dependency-graph--loading" : ""}`}>
            <div className="graph-guidance">{lens === "infrastructure" ? "Topology · redundancy · validated engineering relationships" : lens === "consequence" ? "Population · critical facilities · uncovered duration" : "Verified · stale · unknown · conflicting evidence"}</div>
            {detail?.dependency_subgraph.edges.map((edge) => { const from = positions.get(edge.from_id); const to = positions.get(edge.to_id); if (!from || !to) return null; const dx = to.x - from.x; const dy = to.y - from.y; const width = Math.sqrt(dx * dx + dy * dy); const gap = detail.assessment.max_uncovered_hours > 0 && edge.from_id === detail.asset.sgw_id; const uncertain = !edge.verified || edge.confidence < .8; return <button key={`${edge.from_id}-${edge.to_id}-${edge.relationship}`} className={`graph-edge graph-edge--${edge.relationship}${uncertain ? " graph-edge--uncertain" : " graph-edge--verified"}${gap ? " graph-edge--gap" : ""}`} style={{ left: `${from.x}%`, top: `${from.y}%`, width: `${width}%`, transform: `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)` }} onMouseEnter={() => setHoveredEdge(edge)} onMouseLeave={() => setHoveredEdge(null)} onFocus={() => setHoveredEdge(edge)} onBlur={() => setHoveredEdge(null)} aria-label={`${edge.from_id} ${edge.relationship} ${edge.to_id}`}><i /><span>{edgeLabel(edge.relationship)}</span></button>; })}
            {detail?.dependency_subgraph.nodes.map((node) => { const point = positions.get(node.sgw_id); const context = detail.node_context[node.sgw_id]; if (!point || !context) return null; const consequenceNode = node.asset_type === "water_zone" || !["substation", "pump_station"].includes(node.asset_type); const muted = lens === "consequence" && !consequenceNode; return <button key={node.sgw_id} className={`graph-node graph-node--${node.asset_type} graph-node--${context.assessment.tier}${focusedId === node.sgw_id ? " graph-node--focused" : ""}${muted ? " graph-node--muted" : ""}${lens === "confidence" ? ` graph-node--confidence-${context.assessment.confidence}` : ""}`} style={{ left: `${point.x}%`, top: `${point.y}%` }} onClick={() => setFocusedId(node.sgw_id)} onMouseEnter={() => setHoveredNode(node.sgw_id)} onMouseLeave={() => setHoveredNode(null)} onFocus={() => setHoveredNode(node.sgw_id)} onBlur={() => setHoveredNode(null)}><span className="graph-node-id">{compactId(node.sgw_id)}</span><small>{title(node.asset_type)}</small>{lens === "consequence" && node.asset_type === "water_zone" && <b>{Number(node.attributes.population ?? 0).toLocaleString("en-US")} residents</b>}{lens === "confidence" && <b>{context.assessment.confidence} evidence</b>}</button>; })}
            {hoveredNode && detail?.node_context[hoveredNode] && (() => { const context = detail.node_context[hoveredNode]; const point = positions.get(hoveredNode)!; return <div className="graph-tooltip" style={{ left: `${point.x}%`, top: `${point.y}%` }}><strong>{compactId(hoveredNode)} · {title(context.asset.asset_type)}</strong>{context.asset.asset_type === "pump_station" ? <><span>Backup: {formatValue(context.state.backup_available_hours, "h")}</span><span>Generator readiness: {title(context.state.verification_status)}</span></> : <><span>Risk: {Math.round(context.assessment.risk_score)} · {title(context.assessment.tier)}</span><span>{context.asset.asset_type === "water_zone" ? `Population: ${Number(context.asset.attributes.population ?? 0).toLocaleString("en-US")}` : `Condition: ${context.asset.condition_score}/100`}</span></>}<span>Confidence: {title(context.assessment.confidence)}</span></div>; })()}
            {hoveredEdge && (() => { const from = positions.get(hoveredEdge.from_id)!; const to = positions.get(hoveredEdge.to_id)!; const uncertain = !hoveredEdge.verified || hoveredEdge.confidence < .8; return <div className="edge-tooltip" style={{ left: `${(from.x + to.x) / 2}%`, top: `${(from.y + to.y) / 2}%` }}><strong>{compactId(hoveredEdge.from_id)} → {compactId(hoveredEdge.to_id)}</strong><span>{title(edgeLabel(hoveredEdge.relationship))}</span><span>{uncertain ? "Dependency inferred / awaiting validation" : "Verified engineering record"}</span><small>Last validated {hoveredEdge.last_validated}</small></div>; })()}
          </div><div className="graph-legend"><span><i className="legend-line legend-line--solid" />Validated dependency</span><span><i className="legend-line legend-line--dashed" />Service consequence</span><span><i className="legend-line legend-line--uncertain" />Unverified</span><span><i className="legend-line legend-line--gap" />Material resilience gap</span></div></div>
        {focused ? <>
          <aside className="asset-detail-rail"><NodeDetail key={focusedId} context={focused} edges={detail?.dependency_subgraph.edges ?? []} actions={detail?.recommended_actions ?? []} stage={stage} /></aside>
          <aside className="asset-ask-rail"><AssetAsk key={`ask-${focusedId}`} context={focused} stage={stage} /></aside>
        </> : <aside className="asset-detail-rail"><p className="empty-detail">Choose a node to inspect its evidence.</p></aside>}
      </section>
    </>}
  </main>;
}
