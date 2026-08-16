"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import OperationalMap, { type HazardArea, type MapLayer, type MapZone } from "./OperationalMap";
import { useIncident } from "./IncidentContext";
import { useSearchParams } from "next/navigation";

type Tier = "critical" | "high" | "medium" | "low";
type ChangeDriver = { metric: string; previous: string | number | null; current: string | number | null; unit: string | null; summary: string };
type RiskDriver = { metric: string; label: string; value: string | number; unit: string | null; impact: string };
type Assessment = {
  sgw_id: string; disruption_likelihood: number; consequence_score: number; risk_score: number; tier: Tier;
  confidence: string; rank: number; previous_rank: number | null; rank_change: number | null; restoration_hours: number;
  max_uncovered_hours: number; limiting_backup_hours: number; primary_change: string | null; change_drivers: ChangeDriver[];
  current_drivers: RiskDriver[];
};
type MapAsset = { sgw_id: string; name: string; asset_type: string; latitude: number; longitude: number; operating_zone: string; hazard: { flood_depth_m: number; wind_gust_kph: number } };
type TrackPoint = { stage: string; latitude: number; longitude: number };
type StatePayload = {
  advisory: { advisory_id: string; stage: string; issued_at: string; event_id: string; storm_category: number; storm_severity: number };
  summary: { critical_assets: number; high_assets: number; exposed_residents: number; open_actions: number; data_freshness_minutes: { weather: number; field_ops: number; maintenance: number } };
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
const TIMELINE = [
  { label: "T-72", value: "T-72" }, { label: "T-48", value: "T-48" }, { label: "T-24", value: "T-24" },
  { label: "T-12", value: "T-12" }, { label: "T0", value: "Landfall" },
] as const;
const RAIL_FILTERS: Array<{ value: RailFilter; label: string }> = [
  { value: "all", label: "All" }, { value: "critical", label: "Critical" }, { value: "high", label: "High" },
  { value: "water", label: "Water" }, { value: "electric", label: "Electric" },
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
  const [hoveredRailId, setHoveredRailId] = useState<string | null>(null);
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
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">SGW</span><div><p className="eyebrow">Southeastern Grid & Water</p><h1>Resilience command</h1></div></div>
        <div className="event-status"><span className="live-dot" aria-hidden="true" /><div><strong>Hurricane Iris</strong><span>Active · Category {state?.advisory.storm_category ?? "—"} · {state?.advisory.stage ?? stage}</span></div></div>
        <div className="updated-at"><span>Updated</span><strong>{issued ? `${issued.toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${issued.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z` : "Connecting"}</strong></div>
      </header>

      <section className="status-strip status-strip--top" aria-label="Current situation summary"><div><strong>{state?.summary.critical_assets ?? 0}</strong><span>Critical</span></div><div><strong>{state?.summary.high_assets ?? 0}</strong><span>High</span></div><div><strong>{compactPopulation(state?.summary.exposed_residents ?? 0)}</strong><span>Residents exposed</span></div><a className="response-kpi" href={`/respond?t=${encodeURIComponent(stage)}`}><strong>{state?.summary.open_actions ?? 0}</strong><span>Open actions →</span></a><div className="status-strip-context"><span>Data freshness</span><strong>Weather {freshness(state?.summary.data_freshness_minutes.weather)} · Field Ops {freshness(state?.summary.data_freshness_minutes.field_ops)} · Maintenance {freshness(state?.summary.data_freshness_minutes.maintenance)}</strong></div></section>

      <nav className="timeline" aria-label="Hurricane advisory timeline">
        <span className="timeline-label">Advisory</span><div className="timeline-track" aria-hidden="true" />
        {TIMELINE.map((item) => <button key={item.value} className={stage === item.value ? "timeline-stop timeline-stop--active" : "timeline-stop"} onClick={() => setStage(item.value)} aria-pressed={stage === item.value}><span className="timeline-node" /><span>{item.label}</span></button>)}
        <div className="timeline-context"><span>Forecast confidence</span><strong>{selectedAssessment?.confidence ?? "—"}</strong></div>
      </nav>

      <section className="workspace">
        <div className="map-panel">
          <div className="map-toolbar">
            <div><p className="eyebrow">Synthetic US Atlantic territory</p><h2>Network exposure</h2></div>
            <div className="layer-groups" aria-label="Map layers">
              {([
                ["Assets", [["electric", "Electric"], ["water", "Water"], ["facilities", "Critical Facilities"]]],
                ["Operational", [["serviceZones", "Service Zones"], ["dependencies", "Dependencies"]]],
                ["Hazard", [["stormTrack", "Storm Track"], ["windExposure", "Wind Exposure"], ["floodExposure", "Flood Exposure"]]],
              ] as Array<[string, Array<[MapLayer, string]>]>).map(([group, controls]) => <div className="layer-group" key={group}><span>{group}</span><div>{controls.map(([key, label]) => <button key={key} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} className={layers[key] ? "layer-button layer-button--active" : "layer-button"} aria-pressed={layers[key]}>{label}</button>)}</div></div>)}
            </div>
            <button className={biggestChanges ? "change-toggle change-toggle--active" : "change-toggle"} onClick={() => setBiggestChanges((current) => !current)} aria-pressed={biggestChanges}><span aria-hidden="true">↗</span>Show biggest changes</button>
          </div>

          <div className={`event-map${loading ? " event-map--loading" : ""}`}>
            <OperationalMap assets={state?.map.assets ?? []} assessments={assessments} selectedId={selectedId} selectedNodes={detailNodes} selectedEdges={previewEdges} operatingZones={state?.map.operating_zones ?? []} hazardAreas={state?.map.hazard_areas ?? []} hurricane={state?.map.hurricane ?? null} layers={layers} biggestChanges={biggestChanges} majorChanges={majorChanges} onSelect={setSelectedId} />
            {error && <div className="connection-error" role="alert"><span>Live state unavailable</span><p>{error}</p><button onClick={() => void loadState(stage)}>Retry connection</button></div>}
            <div className="map-legend"><div><span><i className="legend-dot legend-dot--critical" />Critical</span><span><i className="legend-dot legend-dot--high" />High</span><span><i className="legend-dot legend-dot--medium" />Medium</span><span><i className="legend-dot legend-dot--low" />Low</span></div><div><span>S Substation</span><span>P Pump</span><span>+ Critical facility</span></div></div>
          </div>
        </div>

        <aside className="priority-rail" aria-label="Priority assets">
          <div className="rail-heading"><div><p className="eyebrow">Decision rail</p><h2>Priority assets</h2></div><span>{state?.advisory.stage ?? stage}</span></div>
          <div className="rail-controls">
            <div className="rail-mode-switch" aria-label="Rail sort mode">
              {(["priority", "change"] as RailMode[]).map((mode) => <button key={mode} className={railMode === mode ? "rail-mode rail-mode--active" : "rail-mode"} onClick={() => setRailMode(mode)} aria-pressed={railMode === mode}>{mode === "priority" ? "Priority" : "Change"}</button>)}
            </div>
            <div className="rail-filters" aria-label="Asset filters">
              {RAIL_FILTERS.map((filter) => <button key={filter.value} className={railFilter === filter.value ? "rail-filter rail-filter--active" : "rail-filter"} onClick={() => setRailFilter(filter.value)} aria-pressed={railFilter === filter.value}>{filter.label}</button>)}
            </div>
          </div>
          <div className="priority-list">
            {railAssessments.map((assessment) => { const asset = assets.get(assessment.sgw_id); const selected = assessment.sgw_id === selectedId; const expanded = selected || hoveredRailId === assessment.sgw_id; return (
              <button key={assessment.sgw_id} className={selected ? "priority-item priority-item--selected" : "priority-item"} onClick={() => setSelectedId(assessment.sgw_id)} onMouseEnter={() => setHoveredRailId(assessment.sgw_id)} onMouseLeave={() => setHoveredRailId(null)} aria-expanded={expanded}>
                <span className="priority-row"><span className="priority-rank">{String(assessment.rank).padStart(2, "0")}</span><span className="priority-main"><strong>{compactId(assessment.sgw_id)}</strong><small>{asset?.name ?? (asset ? assetLabel(asset.asset_type) : "Asset")}</small></span><span className="priority-score"><strong>{Math.round(assessment.risk_score)}</strong><small>risk</small></span><span className={`priority-tier priority-tier--${assessment.tier}`}>{assessment.tier}</span><span className={assessment.rank_change && assessment.rank_change > 0 ? "priority-move priority-move--up" : "priority-move"}>{movement(assessment.rank_change)}</span></span>
                <span className="priority-details">
                  <span className="split-metrics">
                    <span className="split-metric"><span>Likelihood <strong>{Math.round(assessment.disruption_likelihood)}%</strong></span><i><b className="split-bar--likelihood" style={{ width: `${Math.min(100, assessment.disruption_likelihood)}%` }} /></i></span>
                    <span className="split-metric"><span>Consequence <strong>{Math.round(assessment.consequence_score)}</strong></span><i><b className="split-bar--consequence" style={{ width: `${Math.min(100, assessment.consequence_score)}%` }} /></i></span>
                  </span>
                  <span className="confidence-line"><span>Confidence</span><strong>{assessment.confidence}</strong></span>
                  <span className="primary-driver"><span>Top driver</span>{topDriver(assessment)}</span>
                  {selected && <span className="view-risk-prompt">View asset risk →</span>}
                </span>
              </button>
            ); })}
            {!railAssessments.length && <p className="rail-empty">No assets match this filter.</p>}
          </div>
          <div className="rail-note"><span className="rail-note-index">01</span><p>{railMode === "priority" ? "Ranked by systemic risk: likelihood × dependency-aware consequence." : "Ranked by the largest movement since the previous advisory."}</p></div>
        </aside>
      </section>

      {selectedAsset && selectedAssessment && (hasMaterialChange ? <section className="change-panel" aria-live="polite">
        <div className="change-title"><span className={`change-signal change-signal--${selectedAssessment.tier}`} /><div><p className="eyebrow">What changed since {previousStage}</p><h2>{compactId(selectedAsset.sgw_id)} · {selectedAsset.name}</h2></div></div>
        <div className="change-transition"><span>Rank <strong>#{selectedAssessment.previous_rank ?? "—"} → #{selectedAssessment.rank}</strong></span>{findChange(selectedAssessment, "tier") && <span>Tier <strong>{String(findChange(selectedAssessment, "tier")?.previous).toUpperCase()} → {String(findChange(selectedAssessment, "tier")?.current).toUpperCase()}</strong></span>}</div>
        <div className="change-facts">{[findChange(selectedAssessment, "restoration_hours"), findChange(selectedAssessment, "max_uncovered_hours")].filter(Boolean).map((driver) => <span key={driver!.metric}>{driver!.metric.includes("restoration") ? "Restore" : "Backup gap"}<strong>{formatValue(driver!.previous, driver!.unit)} → {formatValue(driver!.current, driver!.unit)}</strong></span>)}</div>
        <p className="change-summary"><strong>Primary insight:</strong> {selectedAssessment.primary_change ?? topDriver(selectedAssessment)}</p>
        <div className="change-actions"><button onClick={() => setChangeDrawer("changes")}>Show all changes</button><button onClick={() => void openExplanation()}>Why {compactId(selectedAsset.sgw_id)}?</button><a href={`/asset-risk?asset=${encodeURIComponent(selectedAsset.sgw_id)}&t=${encodeURIComponent(stage)}`}>View asset risk →</a></div>
      </section> : <section className="change-panel change-panel--quiet" aria-live="polite"><div><p className="eyebrow">What changed</p><h2>{previousStage ? `No material change since ${previousStage}` : "Baseline advisory established"}</h2></div><span>Select a later advisory to compare material movement.</span></section>)}
      {changeDrawer && <><button className="drawer-backdrop" onClick={() => setChangeDrawer(null)} aria-label="Close change drawer" /><aside className="change-drawer" aria-label={changeDrawer === "changes" ? "All advisory changes" : "Grounded asset explanation"}>
        <div className="drawer-heading"><div><p className="eyebrow">{changeDrawer === "changes" ? `Changes since ${previousStage}` : "Grounded explanation"}</p><h2>{changeDrawer === "changes" ? "Top movers" : compactId(selectedId)}</h2></div><button onClick={() => setChangeDrawer(null)} aria-label="Close drawer">×</button></div>
        {changeDrawer === "changes" ? <div className="mover-list">{topMovers.map((item) => { const asset = assets.get(item.sgw_id); const tier = findChange(item, "tier"); return <button key={item.sgw_id} onClick={() => { setSelectedId(item.sgw_id); setChangeDrawer(null); }}><span className={`mover-signal mover-signal--${item.tier}`} /><span><strong>{compactId(item.sgw_id)}</strong><small>{asset?.name ?? "Asset"}</small></span><span className="mover-change"><strong>#{item.previous_rank ?? "—"} → #{item.rank}</strong><small>{tier ? `${String(tier.previous).toUpperCase()} → ${String(tier.current).toUpperCase()}` : item.primary_change ?? "Material movement"}</small></span></button>; })}{!topMovers.length && <p className="drawer-empty">No material movements in this advisory.</p>}</div> : <div className="explanation-body">{explanationLoading && <p className="explanation-loading">Building a response from the locked fact pack…</p>}{explanationError && <p className="explanation-error">{explanationError}</p>}{explanation && <><span className="grounded-badge">Grounded · {explanation.model}</span><h3>{explanation.headline}</h3><p>{explanation.answer}</p><div className="explanation-facts">{explanation.supporting_facts.slice(0, 3).map((fact) => <span key={fact.metric}><small>{fact.label}</small><strong>{formatValue(fact.value, fact.unit)}</strong></span>)}</div><small className="fact-pack-id">Fact pack {explanation.fact_pack_sha256.slice(0, 12)}</small></>}</div>}
      </aside></>}
    </main>
  );
}
