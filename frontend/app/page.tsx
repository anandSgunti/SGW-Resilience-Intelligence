"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  responses: Array<{ status: string }>;
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
  const [focusOpen, setFocusOpen] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
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
  const issued = state ? new Date(state.advisory.issued_at) : null;
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
  const hasMaterialChange = Boolean(previousStage && selectedAssessment && (selectedAssessment.primary_change || selectedAssessment.change_drivers.length || selectedAssessment.rank_change));
  const activeLayers = Object.values(layers).filter(Boolean).length;
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
      <header className="cmd-bar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">SGW</span><div><p className="eyebrow">Southeastern Grid & Water</p><h1>Resilience command</h1></div></div>
        <div className="event-status"><span className="live-dot" aria-hidden="true" /><div><strong>Hurricane Iris</strong><span>Category {state?.advisory.storm_category ?? "—"} · active</span></div></div>
        <div className="cmd-meta">
          <div className="updated-at"><span>Advisory issued</span><strong>{issued ? `${issued.toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${issued.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z` : "Connecting"}</strong></div>
          <div className="updated-at"><span>Data freshness</span><strong>Weather {freshness(state?.summary.data_freshness_minutes.weather)} · Field Ops {freshness(state?.summary.data_freshness_minutes.field_ops)} · Maintenance {freshness(state?.summary.data_freshness_minutes.maintenance)}</strong></div>
        </div>
      </header>

      <nav className="ribbon" aria-label="Hurricane advisory trajectory">
        <span className="ribbon-label">Advisory</span>
        {TIMELINE.map((item, index) => {
          const summary = trajectory[item.value];
          const active = stage === item.value;
          return (
            <button key={item.value} className={`ribbon-step${active ? " ribbon-step--active" : ""}${index < timelineIndex ? " ribbon-step--past" : ""}`} onClick={() => setStage(item.value)} aria-pressed={active} aria-label={`${item.label}: ${summary ? `${summary.critical_assets} critical, ${compactPopulation(summary.exposed_residents)} residents exposed` : "loading"}`}>
              <b>{item.label}</b>
              <em>{summary ? summary.critical_assets : "—"}</em>
              <small>{summary ? `Critical · ${compactPopulation(summary.exposed_residents)} residents` : "Loading…"}</small>
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

      <section className="stage-body">
        <aside className="asset-index" aria-label="Priority assets">
          <div className="index-head">
            <div className="index-title"><span>Priority</span><b>{railAssessments.length} assets</b></div>
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
                <button key={assessment.sgw_id} className={`index-item index-item--${assessment.tier}${selected ? " index-item--selected" : ""}`} onClick={() => { setSelectedId(assessment.sgw_id); setFocusOpen(true); }} aria-current={selected}>
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

        <div className="stage-map">
          <div className="stage-tools">
            <h2>Network exposure</h2>
            <button className={layersOpen ? "index-chip index-chip--active" : "index-chip"} onClick={() => setLayersOpen((current) => !current)} aria-expanded={layersOpen}>Layers · {activeLayers}/8</button>
            <button className={biggestChanges ? "change-toggle change-toggle--active" : "change-toggle"} onClick={() => setBiggestChanges((current) => !current)} aria-pressed={biggestChanges}><span aria-hidden="true">↗</span>Biggest changes</button>
            {!focusOpen && selectedAssessment && <button className="index-chip index-chip--go" onClick={() => setFocusOpen(true)}>Show {compactId(selectedId)} evidence</button>}
            {layersOpen && <div className="layer-popover" role="group" aria-label="Map layers">
              {LAYER_GROUPS.map(([group, controls]) => <div className="layer-group" key={group}><span>{group}</span><div>{controls.map(([key, label]) => <button key={key} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} className={layers[key] ? "layer-button layer-button--active" : "layer-button"} aria-pressed={layers[key]}>{label}</button>)}</div></div>)}
            </div>}
          </div>

          <div className={`event-map${loading ? " event-map--loading" : ""}`}>
            <OperationalMap assets={state?.map.assets ?? []} assessments={assessments} selectedId={selectedId} selectedNodes={detailNodes} selectedEdges={previewEdges} operatingZones={state?.map.operating_zones ?? []} hazardAreas={state?.map.hazard_areas ?? []} hurricane={state?.map.hurricane ?? null} layers={layers} biggestChanges={biggestChanges} majorChanges={majorChanges} onSelect={(id) => { setSelectedId(id); setFocusOpen(true); }} />
            {error && <div className="connection-error" role="alert"><span>Live state unavailable</span><p>{error}</p><button onClick={() => void loadState(stage)}>Retry connection</button></div>}
            <div className="map-legend"><div><span><i className="legend-dot legend-dot--critical" />Critical</span><span><i className="legend-dot legend-dot--high" />High</span><span><i className="legend-dot legend-dot--medium" />Medium</span><span><i className="legend-dot legend-dot--low" />Low</span></div><div><span>S Substation</span><span>P Pump</span><span>+ Critical facility</span></div></div>

            {focusOpen && selectedAsset && selectedAssessment && (
              <aside className="focus-card" aria-label={`Evidence for ${selectedAsset.name}`}>
                <div className="focus-head">
                  <div><p className="eyebrow">Rank {String(selectedAssessment.rank).padStart(2, "0")} · {movement(selectedAssessment.rank_change)} since {previousStage ?? "baseline"}</p><h2>{compactId(selectedAsset.sgw_id)} · {selectedAsset.name}</h2></div>
                  <button className="focus-close" onClick={() => setFocusOpen(false)} aria-label="Close evidence panel">✕</button>
                </div>

                <section className="focus-section">
                  <span className="focus-label">Systemic risk</span>
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
                </section>

                {hasMaterialChange ? (
                  <section className="focus-section focus-section--changed">
                    <span className="focus-label">What changed since {previousStage}</span>
                    <p>{selectedAssessment.primary_change ?? topDriver(selectedAssessment)}</p>
                    <div className="focus-delta">
                      {[findChange(selectedAssessment, "restoration_hours"), findChange(selectedAssessment, "max_uncovered_hours")].filter(Boolean).map((driver) => (
                        <span key={driver!.metric}>{driver!.metric.includes("restoration") ? "Restore" : "Gap"} <b>{formatValue(driver!.previous, driver!.unit)} → {formatValue(driver!.current, driver!.unit)}</b></span>
                      ))}
                      {selectedAssessment.previous_rank && <span>Rank <b>#{selectedAssessment.previous_rank} → #{selectedAssessment.rank}</b></span>}
                    </div>
                  </section>
                ) : (
                  <section className="focus-section focus-section--quiet">
                    <span className="focus-label">What changed</span>
                    <p>{previousStage ? `No material change since ${previousStage}.` : "Baseline advisory established."}</p>
                  </section>
                )}

                <section className="focus-section">
                  <span className="focus-label">Service path · {selectedAssessment.affected_population.toLocaleString("en-US")} residents</span>
                  <p className="focus-path">{[compactId(selectedAsset.sgw_id), ...(detail?.dependency_subgraph.nodes ?? []).filter((node) => node.sgw_id !== selectedAsset.sgw_id).map((node) => compactId(node.sgw_id))].join(" → ") || "No modelled downstream service."}</p>
                </section>

                <div className="focus-actions">
                  <button onClick={() => setChangeDrawer("changes")}>All changes</button>
                  <button onClick={() => void openExplanation()}>Why {compactId(selectedAsset.sgw_id)}?</button>
                  <Link href={`/asset-risk?asset=${encodeURIComponent(selectedAsset.sgw_id)}&t=${encodeURIComponent(stage)}`}>Asset risk →</Link>
                </div>
              </aside>
            )}
          </div>
        </div>
      </section>

      {changeDrawer && <><button className="drawer-backdrop" onClick={() => setChangeDrawer(null)} aria-label="Close change drawer" /><aside className="change-drawer" aria-label={changeDrawer === "changes" ? "All advisory changes" : "Grounded asset explanation"}>
        <div className="drawer-heading"><div><p className="eyebrow">{changeDrawer === "changes" ? `Changes since ${previousStage}` : "Grounded explanation"}</p><h2>{changeDrawer === "changes" ? "Top movers" : compactId(selectedId)}</h2></div><button onClick={() => setChangeDrawer(null)} aria-label="Close drawer">×</button></div>
        {changeDrawer === "changes" ? <div className="mover-list">{topMovers.map((item) => { const asset = assets.get(item.sgw_id); const tier = findChange(item, "tier"); return <button key={item.sgw_id} onClick={() => { setSelectedId(item.sgw_id); setFocusOpen(true); setChangeDrawer(null); }}><span className={`mover-signal mover-signal--${item.tier}`} /><span><strong>{compactId(item.sgw_id)}</strong><small>{asset?.name ?? "Asset"}</small></span><span className="mover-change"><strong>#{item.previous_rank ?? "—"} → #{item.rank}</strong><small>{tier ? `${String(tier.previous).toUpperCase()} → ${String(tier.current).toUpperCase()}` : item.primary_change ?? "Material movement"}</small></span></button>; })}{!topMovers.length && <p className="drawer-empty">No material movements in this advisory.</p>}</div> : <div className="explanation-body">{explanationLoading && <p className="explanation-loading">Building a response from the locked fact pack…</p>}{explanationError && <p className="explanation-error">{explanationError}</p>}{explanation && <><span className="grounded-badge">Grounded · {explanation.model}</span><h3>{explanation.headline}</h3><p>{explanation.answer}</p><div className="explanation-facts">{explanation.supporting_facts.slice(0, 3).map((fact) => <span key={fact.metric}><small>{fact.label}</small><strong>{formatValue(fact.value, fact.unit)}</strong></span>)}</div><small className="fact-pack-id">Fact pack {explanation.fact_pack_sha256.slice(0, 12)}</small></>}</div>}
      </aside></>}
    </main>
  );
}
