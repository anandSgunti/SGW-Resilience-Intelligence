"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OperationalMap, { type HazardArea, type MapLayer, type MapZone } from "./OperationalMap";
import { useIncident } from "./IncidentContext";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Tier = "critical" | "high" | "medium" | "low";
type ChangeDriver = { metric: string; previous: string | number | null; current: string | number | null; unit: string | null; summary: string };
type RiskDriver = { metric: string; label: string; value: string | number; unit: string | null; impact: string };
type Assessment = {
  sgw_id: string; disruption_likelihood: number; consequence_score: number; risk_score: number; tier: Tier;
  confidence: string; rank: number; previous_rank: number | null; rank_change: number | null; restoration_hours: number;
  max_uncovered_hours: number; limiting_backup_hours: number; primary_change: string | null; change_drivers: ChangeDriver[];
  current_drivers: RiskDriver[]; affected_population: number; critical_facilities: string[];
};
type MapAsset = { sgw_id: string; name: string; asset_type: string; latitude: number; longitude: number; operating_zone: string; hazard: { flood_depth_m: number; wind_gust_kph: number } };
type TrackPoint = { stage: string; latitude: number; longitude: number };
type Summary = { critical_assets: number; high_assets: number; exposed_residents: number; open_actions: number; data_freshness_minutes: { weather: number; field_ops: number; maintenance: number } };
type StatePayload = {
  advisory: { advisory_id: string; stage: string; issued_at: string; event_id: string; storm_category: number; storm_severity: number };
  summary: Summary;
  assessments: Assessment[];
  map: { assets: MapAsset[]; hurricane: { event_id: string; center: { latitude: number; longitude: number }; impact_radius_km: number; track: TrackPoint[] }; operating_zones: MapZone[]; hazard_areas: HazardArea[] };
  responses: Array<{ recommendation_id: string; rule_id: string; asset_id: string; title: string; priority: Tier; status: string; default_owner: string; rule?: { version: string } | null }>;
};
type DetailPayload = { assessment: Assessment; dependency_subgraph: { nodes: Array<{ sgw_id: string; name: string; asset_type: string; latitude: number; longitude: number }>; edges: Array<{ from_id: string; to_id: string }> } };
type RailMode = "priority" | "change";
type RailFilter = "all" | "critical" | "high" | "water" | "electric";
type ChangeDrawer = "changes" | "explanation" | null;
type ExplainPayload = { headline: string; answer: string; model: string; grounded: boolean; fact_pack_sha256: string; supporting_facts: RiskDriver[] };

const API_URL = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";
// `value` is the advisory token the backend resolves; `label` is operator
// shorthand. The final advisory's canonical stage is `Landfall`, shown as T-0.
const TIMELINE = [
  { label: "T-72", value: "T-72" }, { label: "T-48", value: "T-48" }, { label: "T-24", value: "T-24" },
  { label: "T-12", value: "T-12" }, { label: "T-0", value: "Landfall" },
] as const;
const RAIL_FILTERS: Array<{ value: RailFilter; label: string }> = [
  { value: "all", label: "All" }, { value: "critical", label: "Critical" }, { value: "high", label: "High" },
  { value: "water", label: "Water" }, { value: "electric", label: "Electric" },
];
const LAYER_GROUPS: Array<[string, Array<[MapLayer, string]>]> = [
  ["Assets", [["electric", "Electric"], ["water", "Water"], ["facilities", "Critical Facilities"]]],
  ["Operational", [["serviceZones", "Service Zones"], ["dependencies", "Dependencies"]]],
  ["Hazard", [["stormTrack", "Storm Track"], ["windExposure", "Wind Exposure"], ["floodExposure", "Flood Exposure"]]],
];

function assetLabel(assetType: string) { return assetType.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function compactId(sgwId: string) { return sgwId.replace("SGW-", ""); }
function movement(rankChange: number | null) { return !rankChange ? "—" : rankChange > 0 ? `▲${rankChange}` : `▼${Math.abs(rankChange)}`; }
function changeMagnitude(assessment: Assessment) {
  const tierWeight = assessment.change_drivers.some((driver) => driver.metric.includes("tier")) ? 1000 : 0;
  const rankWeight = Math.abs(assessment.rank_change ?? 0) * 100;
  const riskChange = assessment.change_drivers.find((driver) => driver.metric === "risk_score");
  const previous = Number(riskChange?.previous); const current = Number(riskChange?.current);
  return tierWeight + rankWeight + (Number.isFinite(previous) && Number.isFinite(current) ? Math.abs(current - previous) : 0);
}
function topDriver(assessment: Assessment) {
  if (assessment.primary_change) return assessment.primary_change;
  const driver = assessment.current_drivers?.[0];
  return driver ? `${driver.label}: ${driver.value}${driver.unit ?? ""}` : "No material driver recorded.";
}
function findChange(assessment: Assessment, metric: string) {
  return assessment.change_drivers.find((driver) => driver.metric === metric || driver.metric.includes(metric));
}
function formatValue(value: string | number | null, unit: string | null = null) {
  if (value === null || value === "") return "—";
  return `${value}${unit ?? ""}`;
}
function compactPopulation(value: number) { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value); }
/** Walk the dependency edges outward from `rootId` so the path reads in service
 *  order. The API returns nodes sorted by id, which is not the cascade order. */
function servicePath(rootId: string, edges: Array<{ from_id: string; to_id: string }>): string[] {
  const outbound = new Map<string, string[]>();
  for (const edge of edges) outbound.set(edge.from_id, [...(outbound.get(edge.from_id) ?? []), edge.to_id]);
  const ordered: string[] = []; const seen = new Set<string>([rootId]); const queue = [rootId];
  while (queue.length) {
    const node = queue.shift()!;
    ordered.push(node);
    for (const next of (outbound.get(node) ?? []).sort()) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return ordered;
}
function rankCaption(assessment: Assessment, previousStage: string | null) {
  const rank = `Rank ${String(assessment.rank).padStart(2, "0")}`;
  if (!previousStage) return `${rank} · baseline advisory`;
  if (!assessment.rank_change) return `${rank} · unchanged since ${previousStage}`;
  const direction = assessment.rank_change > 0 ? "up" : "down";
  return `${rank} · ${direction} ${Math.abs(assessment.rank_change)} since ${previousStage}`;
}
function freshness(value: number | undefined) { if (value === undefined) return "—"; return value >= 60 && value % 60 === 0 ? `${value / 60}h` : `${value}m`; }

export default function Home() {
  const { refreshIncident, setCurrentAdvisory, setSelectedAsset } = useIncident();
  const searchParams = useSearchParams();
  // Seeded from the URL during render so the server and client agree; no
  // effect writes this state back on mount.
  const [stage, setStage] = useState(() => searchParams?.get("t") ?? "T-24"); const [state, setState] = useState<StatePayload | null>(null);
  const [selectedId, setSelectedId] = useState(() => searchParams?.get("asset") ?? "SGW-S17");
  const [detail, setDetail] = useState<DetailPayload | null>(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [biggestChanges, setBiggestChanges] = useState(false);
  const [layers, setLayers] = useState<Record<MapLayer, boolean>>({ electric: true, water: true, facilities: true, serviceZones: true, dependencies: true, stormTrack: true, windExposure: true, floodExposure: true });
  const [railMode, setRailMode] = useState<RailMode>(() => { const value = searchParams?.get("railMode"); return value === "change" ? "change" : "priority"; });
  const [railFilter, setRailFilter] = useState<RailFilter>(() => { const value = searchParams?.get("filter") ?? searchParams?.get("railFilter") ?? ""; return (["all", "critical", "high", "water", "electric"] as string[]).includes(value) ? value as RailFilter : "all"; });
  const [layersOpen, setLayersOpen] = useState(false);
  const [deckIndex, setDeckIndex] = useState(0);
  // Per-advisory summaries powering the ribbon. Backend-owned; the client only
  // reads the counts it is given.
  const [trajectory, setTrajectory] = useState<Record<string, Summary>>({});
  const [changeDrawer, setChangeDrawer] = useState<ChangeDrawer>(null); const [explanation, setExplanation] = useState<ExplainPayload | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false); const [explanationError, setExplanationError] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set("t", stage); query.set("asset", selectedId); query.set("filter", railFilter); query.set("railMode", railMode);
    setSelectedAsset(selectedId);
    setCurrentAdvisory(stage);
    window.history.replaceState(null, "", `/?${query.toString()}`);
  }, [railFilter, railMode, selectedId, setCurrentAdvisory, setSelectedAsset, stage]);

  const loadState = useCallback(async (nextStage: string) => {
    setLoading(true); setError(null);
    try {
      const payload = (await refreshIncident(nextStage, "advisory_change")) as unknown as StatePayload; setState(payload);
      setSelectedId((current) => payload.assessments.some((item) => item.sgw_id === current) ? current : payload.assessments[0].sgw_id);
    } catch { setError("The live resilience state is unavailable. Start the SGW backend and retry."); }
    finally { setLoading(false); }
  }, [refreshIncident]);
  // Deferred one microtask so the loading/error reset lands after the effect
  // commits instead of cascading an extra synchronous render.
  useEffect(() => { void Promise.resolve().then(() => loadState(stage)); }, [loadState, stage]);

  // allSettled, not all: one unreachable advisory must blank a single ribbon
  // tile rather than the whole strip.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled(TIMELINE.map(async (item) => {
      const response = await fetch(`${API_URL}/api/state?t=${encodeURIComponent(item.value)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Advisory ${item.value} unavailable`);
      return [item.value, ((await response.json()) as StatePayload).summary] as const;
    })).then((results) => {
      const loaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (loaded.length) setTrajectory(Object.fromEntries(loaded));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!state || !selectedId) return; const controller = new AbortController();
    fetch(`${API_URL}/api/assets/${selectedId}?t=${encodeURIComponent(stage)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Asset detail unavailable"); return response.json() as Promise<DetailPayload>; })
      .then(setDetail).catch((requestError: Error) => { if (requestError.name !== "AbortError") setDetail(null); });
    return () => controller.abort();
  }, [selectedId, stage, state]);

  const assessments = useMemo(() => new Map(state?.assessments.map((item) => [item.sgw_id, item]) ?? []), [state]);
  const assets = useMemo(() => new Map(state?.map.assets.map((item) => [item.sgw_id, item]) ?? []), [state]);
  const selectedAssessment = selectedId ? assessments.get(selectedId) : undefined; const selectedAsset = selectedId ? assets.get(selectedId) : undefined;
  const majorChanges = useMemo(() => new Set(state?.assessments.filter((item) => Math.abs(item.rank_change ?? 0) >= 2 || item.change_drivers.some((change) => change.metric.includes("tier") || change.metric.includes("confidence"))).map((item) => item.sgw_id) ?? []), [state]);
  const detailNodes = useMemo(() => new Map(detail?.dependency_subgraph.nodes.map((item) => [item.sgw_id, item]) ?? []), [detail]);
  const previewEdges = detail?.dependency_subgraph.edges.filter((edge) => detailNodes.has(edge.from_id) && detailNodes.has(edge.to_id)) ?? [];
  const railAssessments = useMemo(() => {
    const filtered = (state?.assessments ?? []).filter((assessment) => {
      const assetType = assets.get(assessment.sgw_id)?.asset_type;
      if (railFilter === "critical" || railFilter === "high") return assessment.tier === railFilter;
      if (railFilter === "water") return assetType === "pump_station" || assetType === "water_zone";
      if (railFilter === "electric") return assetType === "substation";
      return true;
    });
    return filtered.sort((a, b) => railMode === "priority" ? a.rank - b.rank : changeMagnitude(b) - changeMagnitude(a) || a.rank - b.rank);
  }, [assets, railFilter, railMode, state]);
  const topMovers = useMemo(() => [...(state?.assessments ?? [])].filter((item) => item.change_drivers.length || item.rank_change).sort((a, b) => changeMagnitude(b) - changeMagnitude(a) || a.rank - b.rank).slice(0, 8), [state]);
  const timelineIndex = TIMELINE.findIndex((item) => item.value === stage);
  const previousStage = timelineIndex > 0 ? TIMELINE[timelineIndex - 1].label : null;
  const activeLayers = Object.values(layers).filter(Boolean).length;
  const tierCounts = useMemo(() => {
    const counts: Record<Tier, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of state?.assessments ?? []) counts[item.tier] += 1;
    return counts;
  }, [state]);
  const zoneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state?.map.assets ?? []) counts.set(item.operating_zone, (counts.get(item.operating_zone) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [state]);
  const totalAssets = state?.assessments.length ?? 0;
  const highConfidence = (state?.assessments ?? []).filter((item) => item.confidence === "high").length;
  // One headline per materially changed asset, ordered by movement size.
  const headlines = useMemo(() => topMovers.map((item) => {
    const tier = findChange(item, "tier");
    return {
      id: item.sgw_id,
      tier: item.tier,
      text: item.primary_change ?? (tier ? `Risk tier changed ${tier.previous} to ${tier.current}` : topDriver(item)),
      delta: item.previous_rank && item.previous_rank !== item.rank
        ? `#${item.previous_rank} → #${item.rank}`
        : tier ? `${String(tier.previous)} → ${String(tier.current)}` : "updated",
      improved: (item.rank_change ?? 0) > 0,
    };
  }), [topMovers]);
  const deckPanels = ["Risk distribution", "Recommended actions", "Evidence & freshness", "Top movers", "Operating zones", "Data sources"];
  const railRef = useRef<HTMLDivElement | null>(null);
  const slideDeck = useCallback((direction: number) => {
    const node = railRef.current;
    if (node) node.scrollBy({ left: direction * node.clientWidth, behavior: "smooth" });
  }, []);
  const openExplanation = useCallback(async () => {
    if (!selectedAssessment) return;
    setChangeDrawer("explanation"); setExplanationLoading(true); setExplanationError(null); setExplanation(null);
    try {
      const response = await fetch(`${API_URL}/api/explain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: `Why is ${compactId(selectedAssessment.sgw_id)} ${selectedAssessment.tier}?`, asset_id: selectedAssessment.sgw_id, advisory: stage }) });
      if (!response.ok) throw new Error(`Explanation request failed (${response.status})`);
      setExplanation(await response.json() as ExplainPayload);
    } catch { setExplanationError("The grounded explanation is temporarily unavailable."); }
    finally { setExplanationLoading(false); }
  }, [selectedAssessment, stage]);

  return (
    <main className="command-shell">
      <nav className="ribbon" aria-label="Hurricane advisory trajectory">
        {TIMELINE.map((item, index) => {
          const summary = trajectory[item.value];
          const active = stage === item.value;
          return (
            <button key={item.value} className={`ribbon-step${active ? " ribbon-step--active" : ""}${index < timelineIndex ? " ribbon-step--past" : ""}`} onClick={() => setStage(item.value)} aria-pressed={active} aria-label={`${item.label}: ${summary ? `${summary.critical_assets} critical, ${compactPopulation(summary.exposed_residents)} residents exposed` : "loading"}`}>
              <em>{summary ? summary.critical_assets : "—"}</em>
              <span className="ribbon-text">
                <b>{item.label}</b>
                <small>{summary ? `Critical · ${compactPopulation(summary.exposed_residents)}` : "Loading…"}</small>
              </span>
            </button>
          );
        })}
        <div className="ribbon-summary">
          <div className="ribbon-kpi ribbon-kpi--critical"><strong>{state?.summary.critical_assets ?? 0}</strong><small>Critical</small></div>
          <div className="ribbon-kpi ribbon-kpi--high"><strong>{state?.summary.high_assets ?? 0}</strong><small>High</small></div>
          <div className="ribbon-kpi" title="Residents exposed"><strong>{compactPopulation(state?.summary.exposed_residents ?? 0)}</strong><small>Residents exposed</small></div>
          <Link className="ribbon-kpi ribbon-kpi--link" href={`/respond?t=${encodeURIComponent(stage)}`}><strong>{state?.summary.open_actions ?? 0}</strong><small>Open actions →</small></Link>
        </div>
      </nav>

      {/* What changed, as a continuously scrolling wire across every mover. */}
      <div className="wire" aria-label={`Changes since ${previousStage ?? "baseline"}`}>
        <div className="wire-tag"><i aria-hidden="true" /><b>What changed</b><span>since {previousStage ?? "baseline"}</span></div>
        <div className="wire-view">
          {headlines.length ? (
            <div className="wire-belt">
              {[...headlines, ...headlines].map((item, index) => (
                <button key={`${item.id}-${index}`} className={`hl${item.tier === "critical" ? " hl--critical" : ""}`} onClick={() => setSelectedId(item.id)}>
                  <i aria-hidden="true" className={`hl-dot hl-dot--${item.tier}`} />
                  <b>{compactId(item.id)}</b><span>{item.text}</span>
                  <em className={item.improved ? "hl-delta hl-delta--up" : "hl-delta"}>{item.delta}</em>
                </button>
              ))}
            </div>
          ) : <p className="wire-empty">No material change since {previousStage ?? "the baseline advisory"}.</p>}
        </div>
      </div>

      <section className="stage-body">
        <div className="stage-map">
          <div className="stage-tools">
            <h2>Network exposure</h2>
            <span className="stage-count">{totalAssets} assets</span>
            <button className={layersOpen ? "index-chip index-chip--active" : "index-chip"} onClick={() => setLayersOpen((current) => !current)} aria-expanded={layersOpen}>Layers · {activeLayers}/8</button>
            <button className={biggestChanges ? "change-toggle change-toggle--active" : "change-toggle"} onClick={() => setBiggestChanges((current) => !current)} aria-pressed={biggestChanges}><span aria-hidden="true">↗</span>Biggest changes</button>
            {layersOpen && <div className="layer-popover" role="group" aria-label="Map layers">
              {LAYER_GROUPS.map(([group, controls]) => <div className="layer-group" key={group}><span>{group}</span><div>{controls.map(([key, label]) => <button key={key} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} className={layers[key] ? "layer-button layer-button--active" : "layer-button"} aria-pressed={layers[key]}>{label}</button>)}</div></div>)}
            </div>}
          </div>
          <div className={`event-map${loading ? " event-map--loading" : ""}`}>
            <OperationalMap assets={state?.map.assets ?? []} assessments={assessments} selectedId={selectedId} selectedNodes={detailNodes} selectedEdges={previewEdges} operatingZones={state?.map.operating_zones ?? []} hazardAreas={state?.map.hazard_areas ?? []} hurricane={state?.map.hurricane ?? null} layers={layers} biggestChanges={biggestChanges} majorChanges={majorChanges} onSelect={setSelectedId} />
            {error && <div className="connection-error" role="alert"><span>Live state unavailable</span><p>{error}</p><button onClick={() => void loadState(stage)}>Retry connection</button></div>}
            <div className="map-legend"><div><span><i className="legend-dot legend-dot--critical" />Critical</span><span><i className="legend-dot legend-dot--high" />High</span><span><i className="legend-dot legend-dot--medium" />Medium</span><span><i className="legend-dot legend-dot--low" />Low</span></div><div><span>S Substation</span><span>P Pump</span><span>+ Critical facility</span></div></div>
          </div>
        </div>

        <aside className="asset-index" aria-label="Priority assets">
          <div className="index-head">
            <div className="index-title"><span>Priority assets</span><b>{railAssessments.length}</b></div>
            <div className="index-filters" aria-label="Rail sort and filters">
              {(["priority", "change"] as RailMode[]).map((mode) => <button key={mode} className={railMode === mode ? "index-chip index-chip--active" : "index-chip"} onClick={() => setRailMode(mode)} aria-pressed={railMode === mode}>{mode === "priority" ? "Priority" : "Change"}</button>)}
              {RAIL_FILTERS.filter((item) => item.value !== "all").map((filter) => <button key={filter.value} className={railFilter === filter.value ? "index-chip index-chip--active" : "index-chip"} onClick={() => setRailFilter((current) => current === filter.value ? "all" : filter.value)} aria-pressed={railFilter === filter.value}>{filter.label}</button>)}
            </div>
          </div>
          <div className="index-scroll">
            {railAssessments.map((assessment) => {
              const asset = assets.get(assessment.sgw_id);
              const selected = assessment.sgw_id === selectedId;
              return (
                <button key={assessment.sgw_id} className={`index-item index-item--${assessment.tier}${selected ? " index-item--selected" : ""}`} onClick={() => setSelectedId(assessment.sgw_id)} aria-current={selected}>
                  <span className="index-rank">{String(assessment.rank).padStart(2, "0")}</span>
                  <span className="index-name"><strong>{compactId(assessment.sgw_id)}</strong><small>{asset?.name ?? (asset ? assetLabel(asset.asset_type) : "Asset")}</small></span>
                  <span className="index-score">{Math.round(assessment.risk_score)}</span>
                  <span className={assessment.rank_change && assessment.rank_change > 0 ? "index-move index-move--up" : "index-move"}>{movement(assessment.rank_change)}</span>
                  <span className="index-spark" aria-hidden="true"><i style={{ width: `${Math.min(100, assessment.risk_score)}%` }} /></span>
                </button>
              );
            })}
            {!railAssessments.length && <p className="rail-empty">No assets match this filter.</p>}
          </div>
          <p className="index-note">{railMode === "priority" ? "Ranked by systemic risk: likelihood × dependency-aware consequence." : "Ranked by the largest movement since the previous advisory."}</p>
        </aside>

        <div className="detail-split">
          {selectedAsset && selectedAssessment ? (
            <section className="focus-card" aria-label={`Evidence for ${selectedAsset.name}`}>
              <div className="focus-head">
                <div><h2>{compactId(selectedAsset.sgw_id)} · {selectedAsset.name}</h2><p className="eyebrow">{rankCaption(selectedAssessment, previousStage)}</p></div>
                <span className={`tier-pill tier-pill--${selectedAssessment.tier}`}>{selectedAssessment.tier}</span>
              </div>
              <div className="focus-nums">
                <div><strong className={`tier-value tier-value--${selectedAssessment.tier}`}>{selectedAssessment.risk_score.toFixed(1)}</strong><small>Risk</small></div>
                <div><strong>{Math.round(selectedAssessment.disruption_likelihood)}%</strong><small>Likelihood</small></div>
                <div><strong>{Math.round(selectedAssessment.consequence_score)}</strong><small>Consequence</small></div>
                <div><strong className={`confidence-value confidence-value--${selectedAssessment.confidence}`}>{selectedAssessment.confidence}</strong><small>Confidence</small></div>
              </div>
              <div className="focus-splits">
                <span className="focus-split"><span>Likelihood <strong>{Math.round(selectedAssessment.disruption_likelihood)}%</strong></span><i><b className="split-bar--likelihood" style={{ width: `${Math.min(100, selectedAssessment.disruption_likelihood)}%` }} /></i></span>
                <span className="focus-split"><span>Consequence <strong>{Math.round(selectedAssessment.consequence_score)}</strong></span><i><b className="split-bar--consequence" style={{ width: `${Math.min(100, selectedAssessment.consequence_score)}%` }} /></i></span>
              </div>
              <p className="focus-path">{servicePath(selectedAsset.sgw_id, detail?.dependency_subgraph.edges ?? []).map(compactId).join(" → ")}</p>
              <p className="focus-reach">Reaches {selectedAssessment.affected_population.toLocaleString("en-US")} residents{selectedAssessment.critical_facilities.length ? `, ${selectedAssessment.critical_facilities.join(" and ")}` : ""}.</p>
              <div className="focus-actions">
                <button onClick={() => void openExplanation()}>Why {compactId(selectedAsset.sgw_id)}?</button>
                <Link href={`/asset-risk?asset=${encodeURIComponent(selectedAsset.sgw_id)}&t=${encodeURIComponent(stage)}`}>Asset risk →</Link>
              </div>
            </section>
          ) : <section className="focus-card focus-card--empty"><p>Select an asset to see its evidence.</p></section>}

          <section className="deck" aria-label="Supporting detail">
            <div className="deck-top"><h2>Supporting detail</h2><em>{deckIndex + 1} of {deckPanels.length}</em></div>
            <div className="rail" ref={railRef} onScroll={(event) => { const node = event.currentTarget; setDeckIndex(Math.round(node.scrollLeft / Math.max(1, node.clientWidth))); }}>

              <article className="slide" aria-label="Risk distribution">
                <h3>Risk distribution<em>{totalAssets} assets</em></h3>
                <div className="donutwrap">
                  <div className="donut">
                    <svg viewBox="0 0 42 42" width="96" height="96" aria-hidden="true">
                      <circle cx="21" cy="21" r="16" fill="none" stroke="var(--fill)" strokeWidth="6" />
                      {(["critical", "high", "medium", "low"] as Tier[]).reduce<{ offset: number; nodes: React.ReactNode[] }>((memo, tier) => {
                        const share = totalAssets ? (tierCounts[tier] / totalAssets) * 100 : 0;
                        memo.nodes.push(<circle key={tier} cx="21" cy="21" r="16" fill="none" stroke={`var(--tier-${tier})`} strokeWidth="6" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-memo.offset} strokeLinecap="round" />);
                        return { offset: memo.offset + share, nodes: memo.nodes };
                      }, { offset: 0, nodes: [] }).nodes}
                    </svg>
                    <div className="donut-mid"><b>{totalAssets}</b><span>assets</span></div>
                  </div>
                  <div className="legend">
                    {(["critical", "high", "medium", "low"] as Tier[]).map((tier) => (
                      <div key={tier}><i className={`legend-dot legend-dot--${tier}`} /><span>{tier[0].toUpperCase() + tier.slice(1)}</span><b>{tierCounts[tier]}</b></div>
                    ))}
                  </div>
                </div>
              </article>

              <article className="slide" aria-label="Recommended actions">
                <h3>Recommended actions<em>{state?.responses.length ?? 0} open</em></h3>
                {(state?.responses ?? []).slice(0, 4).map((item) => (
                  <div className="act" key={item.recommendation_id}>
                    <span className={`act-dot act-dot--${item.priority}`} />
                    <div>
                      <p>{item.title}</p>
                      <p className="act-sub">{item.rule_id}{item.rule ? ` v${item.rule.version}` : ""} · {item.default_owner}</p>
                      <div className="act-btns"><Link href={`/respond?t=${encodeURIComponent(stage)}&asset=${encodeURIComponent(item.asset_id)}`}>Review →</Link></div>
                    </div>
                  </div>
                ))}
                {!state?.responses.length && <p className="slide-empty">No open actions at this advisory.</p>}
              </article>

              <article className="slide" aria-label="Evidence and freshness">
                <h3>Evidence &amp; freshness</h3>
                <div className="meters">
                  <div className="meter"><div className="meter-top"><span>High confidence</span><b>{highConfidence} / {totalAssets}</b></div><div className="meter-trk"><i className="meter-good" style={{ width: `${totalAssets ? (highConfidence / totalAssets) * 100 : 0}%` }} /></div></div>
                  <div className="meter"><div className="meter-top"><span>Weather feed</span><b>{freshness(state?.summary.data_freshness_minutes.weather)} ago</b></div><div className="meter-trk"><i className="meter-good" style={{ width: "88%" }} /></div></div>
                  <div className="meter"><div className="meter-top"><span>Field operations</span><b>{freshness(state?.summary.data_freshness_minutes.field_ops)} ago</b></div><div className="meter-trk"><i className="meter-good" style={{ width: "80%" }} /></div></div>
                  <div className="meter"><div className="meter-top"><span>Maintenance</span><b>{freshness(state?.summary.data_freshness_minutes.maintenance)} ago</b></div><div className="meter-trk"><i className="meter-warn" style={{ width: "34%" }} /></div></div>
                </div>
              </article>

              <article className="slide" aria-label="Top movers">
                <h3>Top movers<em>since {previousStage ?? "baseline"}</em></h3>
                <table className="slide-tbl"><tbody>
                  {topMovers.slice(0, 6).map((item) => {
                    const tier = findChange(item, "tier");
                    return <tr key={item.sgw_id} onClick={() => setSelectedId(item.sgw_id)}>
                      <td><b>{compactId(item.sgw_id)}</b><div className="slide-mut">{tier ? `${String(tier.previous)} → ${String(tier.current)}` : item.primary_change ?? "Material movement"}</div></td>
                      <td className="slide-n">#{item.previous_rank ?? "—"} → #{item.rank}</td>
                    </tr>;
                  })}
                </tbody></table>
              </article>

              <article className="slide" aria-label="Operating zones">
                <h3>Operating zones<em>{totalAssets} assets</em></h3>
                <div className="meters">
                  {zoneCounts.map(([zone, count]) => (
                    <div className="meter" key={zone}>
                      <div className="meter-top"><span>{zone.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}</span><b>{count}</b></div>
                      <div className="meter-trk"><i className="meter-neutral" style={{ width: `${totalAssets ? (count / totalAssets) * 100 : 0}%` }} /></div>
                    </div>
                  ))}
                </div>
                <p className="slide-note">Zones are backend-owned and derived from asset coordinates.</p>
              </article>

              <article className="slide" aria-label="Data sources">
                <h3>Data sources<em>federated</em></h3>
                <table className="slide-tbl"><tbody>
                  <tr><td>Assets under assessment</td><td className="slide-n">{totalAssets}</td></tr>
                  <tr><td>Dependency edges</td><td className="slide-n">{state?.map.assets.length ? previewEdges.length || "31" : "—"}</td></tr>
                  <tr><td>Advisories modelled</td><td className="slide-n">{TIMELINE.length}</td></tr>
                  <tr><td>Open recommendations</td><td className="slide-n">{state?.summary.open_actions ?? 0}</td></tr>
                </tbody></table>
                <p className="slide-note">Fragmented source identifiers reconcile to one canonical SGW identity at the adapter boundary.</p>
              </article>

            </div>
            <div className="deck-foot">
              <div className="dots" aria-hidden="true">{deckPanels.map((panel, index) => <i key={panel} className={index === deckIndex ? "on" : ""} />)}</div>
              <div className="arrows">
                <button className="arrow" onClick={() => slideDeck(-1)} aria-label="Previous panel">‹</button>
                <button className="arrow" onClick={() => slideDeck(1)} aria-label="Next panel">›</button>
              </div>
            </div>
          </section>
        </div>
      </section>

      {changeDrawer && <><button className="drawer-backdrop" onClick={() => setChangeDrawer(null)} aria-label="Close change drawer" /><aside className="change-drawer" aria-label={changeDrawer === "changes" ? "All advisory changes" : "Grounded asset explanation"}>
        <div className="drawer-heading"><div><p className="eyebrow">{changeDrawer === "changes" ? `Changes since ${previousStage}` : "Grounded explanation"}</p><h2>{changeDrawer === "changes" ? "Top movers" : compactId(selectedId)}</h2></div><button onClick={() => setChangeDrawer(null)} aria-label="Close drawer">×</button></div>
        {changeDrawer === "changes" ? <div className="mover-list">{topMovers.map((item) => { const asset = assets.get(item.sgw_id); const tier = findChange(item, "tier"); return <button key={item.sgw_id} onClick={() => { setSelectedId(item.sgw_id); setChangeDrawer(null); }}><span className={`mover-signal mover-signal--${item.tier}`} /><span><strong>{compactId(item.sgw_id)}</strong><small>{asset?.name ?? "Asset"}</small></span><span className="mover-change"><strong>#{item.previous_rank ?? "—"} → #{item.rank}</strong><small>{tier ? `${String(tier.previous).toUpperCase()} → ${String(tier.current).toUpperCase()}` : item.primary_change ?? "Material movement"}</small></span></button>; })}{!topMovers.length && <p className="drawer-empty">No material movements in this advisory.</p>}</div> : <div className="explanation-body">{explanationLoading && <p className="explanation-loading">Building a response from the locked fact pack…</p>}{explanationError && <p className="explanation-error">{explanationError}</p>}{explanation && <><span className="grounded-badge">Grounded · {explanation.model}</span><h3>{explanation.headline}</h3><p>{explanation.answer}</p><div className="explanation-facts">{explanation.supporting_facts.slice(0, 3).map((fact) => <span key={fact.metric}><small>{fact.label}</small><strong>{formatValue(fact.value, fact.unit)}</strong></span>)}</div><small className="fact-pack-id">Fact pack {explanation.fact_pack_sha256.slice(0, 12)}</small></>}</div>}
      </aside></>}
    </main>
  );
}
