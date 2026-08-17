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
type Summary = { critical_assets: number; high_assets: number; exposed_residents: number; open_actions: number };
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


const TIER_TEXT: Record<Tier, string> = {
  critical: "text-critical", high: "text-high", medium: "text-medium", low: "text-muted-foreground",
};
const TIER_BG: Record<Tier, string> = {
  critical: "bg-critical", high: "bg-high", medium: "bg-medium", low: "bg-muted-foreground",
};
function chip(active: boolean) {
  return `glass-chip press rounded-full px-3 py-1.5 text-xs font-medium transition-all ${active ? "border border-primary/50 bg-primary/10 text-primary" : "border border-border"}`;
}

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
  const deckPanels = ["Risk distribution", "Recommended actions", "Evidence", "Top movers", "Operating zones", "Data sources"];
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
    <main className="ds-screen mx-auto w-full max-w-[1600px] px-5 pb-16 pt-6 md:px-8">
      {/* Advisory ribbon */}
      <section className="panel rise flex flex-wrap items-center justify-between gap-5 p-5">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Select advisory">
          {TIMELINE.map((item, index) => {
            const entry = trajectory[item.value];
            const active = stage === item.value;
            return (
              <button key={item.value} onClick={() => setStage(item.value)} aria-pressed={active}
                title={entry ? `${item.label}: ${entry.critical_assets} critical · ${compactPopulation(entry.exposed_residents)} residents exposed` : item.label}
                className={`press rounded-2xl px-3.5 py-2 text-left transition-all hover:-translate-y-0.5 ${active ? "border border-primary/50 bg-primary/10" : index < timelineIndex ? "glass-chip border border-border opacity-70" : "glass-chip border border-border"}`}>
                <span className={`font-mono text-[11px] uppercase tracking-widest ${active ? "text-primary" : "text-muted-foreground"}`}>{item.label}</span>
                <strong className="ml-2 font-display text-sm">{entry ? `${entry.critical_assets}C` : "—"}</strong>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Kpi value={state?.summary.critical_assets ?? 0} text="Critical" tone="text-critical" />
          <Kpi value={state?.summary.high_assets ?? 0} text="High" tone="text-high" />
          <Kpi value={compactPopulation(state?.summary.exposed_residents ?? 0)} text="Residents exposed" />
          <Link href={`/respond?t=${encodeURIComponent(stage)}`} className="press rounded-2xl border border-border bg-surface/70 px-4 py-3 hover:border-primary/40">
            <strong className="block font-display text-xl">{state?.summary.open_actions ?? 0}</strong>
            <small className="eyebrow-mono mt-1 block text-muted-foreground">Open actions →</small>
          </Link>
        </div>
      </section>

      {/* What changed wire */}
      <section className="panel rise mt-4 flex items-center gap-3 overflow-hidden px-4 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <b className="text-xs font-semibold">What changed</b>
          <span className="text-[11px] text-muted-foreground">since {previousStage ?? "baseline"}</span>
        </div>
        <div className="relative flex-1 overflow-hidden">
          {headlines.length ? (
            <div className="wire-belt flex w-max gap-2">
              {[...headlines, ...headlines].map((item, index) => (
                <button key={`${item.id}-${index}`} onClick={() => setSelectedId(item.id)}
                  className="glass-chip press flex shrink-0 items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs">
                  <i className={`h-1.5 w-1.5 rounded-full ${TIER_BG[item.tier]}`} />
                  <b>{compactId(item.id)}</b>
                  <span className="max-w-[380px] truncate text-muted-foreground">{item.text}</span>
                  <em className={`not-italic ${item.improved ? "text-verified" : "text-critical"}`}>{item.delta}</em>
                </button>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground">No material change since {previousStage ?? "the baseline advisory"}.</p>}
        </div>
        <button onClick={() => setChangeDrawer("changes")} className="press shrink-0 text-xs font-medium text-primary hover:underline">See all →</button>
      </section>

      {/* Map + rail */}
      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="panel rise relative p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-semibold">Network exposure</h2>
            <span className="text-xs text-muted-foreground">{totalAssets} assets</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setLayersOpen((current) => !current)} aria-expanded={layersOpen} className={chip(layersOpen)}>Layers · {activeLayers}/8</button>
              <button onClick={() => setBiggestChanges((current) => !current)} aria-pressed={biggestChanges} className={chip(biggestChanges)}>↗ Biggest changes</button>
            </div>
          </div>

          {layersOpen ? (
            <div className="panel absolute right-4 top-16 z-[600] w-64 p-4">
              {LAYER_GROUPS.map(([group, controls]) => (
                <div key={group} className="mb-3 last:mb-0">
                  <span className="eyebrow-mono">{group}</span>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {controls.map(([key, text]) => (
                      <button key={key} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} aria-pressed={layers[key]} className={chip(layers[key])}>{text}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className={`h-[460px] overflow-hidden rounded-[18px] border border-border bg-surface-2 ${loading ? "opacity-70" : ""}`}>
            <OperationalMap assets={state?.map.assets ?? []} assessments={assessments} selectedId={selectedId} selectedNodes={detailNodes} selectedEdges={previewEdges}
              operatingZones={state?.map.operating_zones ?? []} hazardAreas={state?.map.hazard_areas ?? []} hurricane={state?.map.hurricane ?? null}
              layers={layers} biggestChanges={biggestChanges} majorChanges={majorChanges} onSelect={setSelectedId} />
          </div>
          {error ? (
            <div className="mt-3 rounded-2xl border border-critical/40 bg-critical/10 px-4 py-3 text-xs">
              <strong className="text-critical">Live state unavailable</strong>
              <p className="mt-1 text-muted-foreground">{error}</p>
              <button onClick={() => void loadState(stage)} className="press mt-2 rounded-full border border-border bg-surface/70 px-3 py-1.5">Retry connection</button>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <div className="flex flex-wrap gap-3">
              {(["critical", "high", "medium", "low"] as Tier[]).map((tier) => (
                <span key={tier} className="flex items-center gap-1.5"><i className={`h-2 w-2 rounded-full ${TIER_BG[tier]}`} />{tier[0].toUpperCase() + tier.slice(1)}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-3"><span>S Substation</span><span>P Pump</span><span>+ Critical facility</span></div>
          </div>
        </div>

        <aside className="panel rise flex flex-col p-4" aria-label="Priority assets">
          <div className="flex items-center justify-between">
            <span className="eyebrow-mono">Priority assets</span>
            <b className="font-display text-sm">{railAssessments.length}</b>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(["priority", "change"] as RailMode[]).map((mode) => (
              <button key={mode} onClick={() => setRailMode(mode)} aria-pressed={railMode === mode} className={chip(railMode === mode)}>{mode === "priority" ? "Priority" : "Change"}</button>
            ))}
            {RAIL_FILTERS.filter((item) => item.value !== "all").map((filter) => (
              <button key={filter.value} onClick={() => setRailFilter((current) => current === filter.value ? "all" : filter.value)} aria-pressed={railFilter === filter.value} className={chip(railFilter === filter.value)}>{filter.label}</button>
            ))}
          </div>

          <div className="mt-3 flex max-h-[420px] flex-col gap-1.5 overflow-y-auto pr-1">
            {railAssessments.map((assessment) => {
              const asset = assets.get(assessment.sgw_id);
              const selected = assessment.sgw_id === selectedId;
              return (
                <button key={assessment.sgw_id} onClick={() => setSelectedId(assessment.sgw_id)} aria-current={selected}
                  className={`press rounded-2xl px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 ${selected ? "border border-primary/50 bg-primary/10" : "glass-chip border border-border"}`}>
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-[11px] text-muted-foreground">{String(assessment.rank).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{compactId(assessment.sgw_id)}</strong>
                      <small className="block truncate text-[11px] text-muted-foreground">{asset?.name ?? (asset ? assetLabel(asset.asset_type) : "Asset")}</small>
                    </span>
                    <span className={`font-display text-sm ${TIER_TEXT[assessment.tier]}`}>{Math.round(assessment.risk_score)}</span>
                    <span className={`w-8 text-right text-[11px] ${(assessment.rank_change ?? 0) > 0 ? "text-verified" : "text-muted-foreground"}`}>{movement(assessment.rank_change)}</span>
                  </div>
                  <span className="mt-2 block h-1 overflow-hidden rounded-full bg-surface-2">
                    <i className={`block h-full rounded-full ${TIER_BG[assessment.tier]}`} style={{ width: `${Math.min(100, assessment.risk_score)}%` }} />
                  </span>
                </button>
              );
            })}
            {!railAssessments.length ? <p className="text-xs text-muted-foreground">No assets match this filter.</p> : null}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            {railMode === "priority" ? "Ranked by systemic risk: likelihood × dependency-aware consequence." : "Ranked by the largest movement since the previous advisory."}
          </p>
        </aside>
      </section>

      {/* Focus + deck */}
      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {selectedAsset && selectedAssessment ? (
          <div className="panel rise p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold">{compactId(selectedAsset.sgw_id)} · {selectedAsset.name}</h2>
                <p className="eyebrow-mono mt-1">{rankCaption(selectedAssessment, previousStage)}</p>
              </div>
              <span className={`glass-chip rounded-full px-3 py-1 text-xs font-semibold uppercase ${TIER_TEXT[selectedAssessment.tier]}`}>{selectedAssessment.tier}</span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat value={selectedAssessment.risk_score.toFixed(0)} text="Risk" tone={TIER_TEXT[selectedAssessment.tier]} />
              <Stat value={`${Math.round(selectedAssessment.disruption_likelihood)}%`} text="Likelihood" />
              <Stat value={Math.round(selectedAssessment.consequence_score)} text="Consequence" />
              <Stat value={selectedAssessment.confidence} text="Confidence" />
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Bar text="Likelihood" value={selectedAssessment.disruption_likelihood} className="bg-high" />
              <Bar text="Consequence" value={selectedAssessment.consequence_score} className="bg-medium" />
            </div>

            <p className="mt-4 font-mono text-xs text-muted-foreground">{servicePath(selectedAsset.sgw_id, detail?.dependency_subgraph.edges ?? []).map(compactId).join(" → ")}</p>
            <p className="mt-2 text-sm leading-relaxed">
              Reaches {selectedAssessment.affected_population.toLocaleString("en-GB")} residents
              {selectedAssessment.critical_facilities.length ? `, ${selectedAssessment.critical_facilities.join(" and ")}` : ""}.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => void openExplanation()} className="press rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Why {compactId(selectedAsset.sgw_id)}?</button>
              <Link href={`/asset-risk?asset=${encodeURIComponent(selectedAsset.sgw_id)}&t=${encodeURIComponent(stage)}`} className="press rounded-full border border-border bg-surface/70 px-4 py-2 text-sm font-medium hover:border-primary/40">Asset risk →</Link>
            </div>
          </div>
        ) : <div className="panel rise flex items-center justify-center p-6 text-sm text-muted-foreground">Select an asset to see its evidence.</div>}

        <div className="panel rise flex flex-col p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Supporting detail</h2>
            <em className="text-xs not-italic text-muted-foreground">{deckIndex + 1} of {deckPanels.length}</em>
          </div>

          <div ref={railRef} onScroll={(event) => { const node = event.currentTarget; setDeckIndex(Math.round(node.scrollLeft / Math.max(1, node.clientWidth))); }}
            className="mt-3 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth">
            <Slide title="Risk distribution" note={`${totalAssets} assets`}>
              <div className="flex flex-col gap-1.5">
                {(["critical", "high", "medium", "low"] as Tier[]).map((tier) => (
                  <div key={tier} className="flex items-center gap-2 text-xs">
                    <i className={`h-2 w-2 rounded-full ${TIER_BG[tier]}`} />
                    <span className="w-16 capitalize">{tier}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <i className={`block h-full rounded-full ${TIER_BG[tier]}`} style={{ width: `${totalAssets ? (tierCounts[tier] / totalAssets) * 100 : 0}%` }} />
                    </span>
                    <b className="w-5 text-right">{tierCounts[tier]}</b>
                  </div>
                ))}
              </div>
            </Slide>

            <Slide title="Recommended actions" note={`${state?.responses.length ?? 0} raised`}>
              <div className="flex flex-col gap-2">
                {(state?.responses ?? []).slice(0, 4).map((item) => (
                  <Link key={item.recommendation_id} href={`/respond?t=${encodeURIComponent(stage)}&asset=${encodeURIComponent(item.asset_id)}`}
                    className="glass-chip press flex items-start gap-2 rounded-2xl border border-border px-3 py-2">
                    <i className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TIER_BG[item.priority]}`} />
                    <span>
                      <b className="block text-xs">{item.title}</b>
                      <small className="text-[11px] text-muted-foreground">{item.rule_id}{item.rule ? ` v${item.rule.version}` : ""} · {item.default_owner}</small>
                    </span>
                  </Link>
                ))}
                {!state?.responses.length ? <p className="text-xs text-muted-foreground">No open actions at this advisory.</p> : null}
              </div>
            </Slide>

            <Slide title="Evidence confidence" note={`${highConfidence} of ${totalAssets} high`}>
              <Bar text="High confidence" value={totalAssets ? (highConfidence / totalAssets) * 100 : 0} className="bg-verified" />
              <p className="mt-3 text-[11px] text-muted-foreground">Confidence is named per evidence type on the asset-risk graph; the path inherits its weakest link.</p>
            </Slide>

            <Slide title="Top movers" note={`since ${previousStage ?? "baseline"}`}>
              <div className="flex flex-col gap-1.5">
                {topMovers.slice(0, 6).map((item) => (
                  <button key={item.sgw_id} onClick={() => setSelectedId(item.sgw_id)}
                    className="glass-chip press flex items-center justify-between gap-3 rounded-2xl border border-border px-3 py-2 text-left">
                    <span className="min-w-0">
                      <b className="text-xs">{compactId(item.sgw_id)}</b>
                      <small className="block truncate text-[11px] text-muted-foreground">{item.primary_change ?? "Material movement"}</small>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{item.previous_rank ?? "—"} → #{item.rank}</span>
                  </button>
                ))}
              </div>
            </Slide>

            <Slide title="Operating zones" note={`${totalAssets} assets`}>
              <div className="flex flex-col gap-2">
                {zoneCounts.map(([zone, count]) => (
                  <Bar key={zone} text={`${assetLabel(zone)} · ${count}`} value={totalAssets ? (count / totalAssets) * 100 : 0} className="bg-medium" />
                ))}
              </div>
            </Slide>

            <Slide title="Data sources" note="federated">
              <dl className="flex flex-col gap-1.5 text-xs">
                <Row label="Assets under assessment" value={totalAssets} />
                <Row label="Advisories modelled" value={TIMELINE.length} />
                <Row label="Open recommendations" value={state?.summary.open_actions ?? 0} />
                <Row label="Critical facilities exposed" value={selectedAssessment?.critical_facilities.length ?? 0} />
              </dl>
              <p className="mt-3 text-[11px] text-muted-foreground">Fragmented source identifiers reconcile to one canonical SGW identity at the adapter boundary.</p>
            </Slide>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <div className="flex gap-1.5" aria-hidden="true">
              {deckPanels.map((panel, index) => <i key={panel} className={`h-1.5 w-1.5 rounded-full ${index === deckIndex ? "bg-primary" : "bg-border"}`} />)}
            </div>
            <div className="flex gap-2">
              <button onClick={() => slideDeck(-1)} aria-label="Previous panel" className="press glass-chip h-8 w-8 rounded-full border border-border">‹</button>
              <button onClick={() => slideDeck(1)} aria-label="Next panel" className="press glass-chip h-8 w-8 rounded-full border border-border">›</button>
            </div>
          </div>
        </div>
      </section>

      {changeDrawer ? (
        <>
          <button onClick={() => setChangeDrawer(null)} aria-label="Close drawer" className="fixed inset-0 z-[900] bg-foreground/20 backdrop-blur-[2px]" />
          <aside className="panel fixed right-0 top-0 z-[1000] flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto rounded-none rounded-l-[18px] p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow-mono">{changeDrawer === "changes" ? `Changes since ${previousStage}` : "Grounded explanation"}</p>
                <h2 className="mt-1 font-display text-lg font-semibold">{changeDrawer === "changes" ? "Top movers" : compactId(selectedId)}</h2>
              </div>
              <button onClick={() => setChangeDrawer(null)} aria-label="Close drawer" className="press glass-chip h-8 w-8 rounded-full border border-border">×</button>
            </div>

            {changeDrawer === "changes" ? (
              <div className="flex flex-col gap-2">
                {topMovers.map((item) => (
                  <button key={item.sgw_id} onClick={() => { setSelectedId(item.sgw_id); setChangeDrawer(null); }}
                    className="glass-chip press flex items-start gap-3 rounded-2xl border border-border px-3 py-2.5 text-left">
                    <i className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TIER_BG[item.tier]}`} />
                    <span className="min-w-0 flex-1">
                      <b className="text-sm">{compactId(item.sgw_id)}</b>
                      <small className="block text-[11px] text-muted-foreground">{assets.get(item.sgw_id)?.name}</small>
                      <small className="mt-1 block text-[11px]">{item.primary_change ?? "Material movement"}</small>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{item.previous_rank ?? "—"} → #{item.rank}</span>
                  </button>
                ))}
                {!topMovers.length ? <p className="text-xs text-muted-foreground">No material movements in this advisory.</p> : null}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {explanationLoading ? <p className="text-sm text-muted-foreground">Building a response from the locked fact pack…</p> : null}
                {explanationError ? <p className="text-sm text-critical">{explanationError}</p> : null}
                {explanation ? (
                  <>
                    <span className="glass-chip w-fit rounded-full border border-verified/40 px-3 py-1 text-[11px] text-verified">Grounded · {explanation.model}</span>
                    <h3 className="font-display text-base font-semibold">{explanation.headline}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{explanation.answer}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {explanation.supporting_facts.slice(0, 3).map((fact) => (
                        <span key={fact.metric} className="glass-chip rounded-2xl border border-border px-3 py-2">
                          <small className="block text-[10px] text-muted-foreground">{fact.label}</small>
                          <strong className="text-sm">{formatValue(fact.value, fact.unit)}</strong>
                        </span>
                      ))}
                    </div>
                    <small className="font-mono text-[11px] text-muted-foreground">Fact pack {explanation.fact_pack_sha256.slice(0, 18)}</small>
                  </>
                ) : null}
              </div>
            )}
          </aside>
        </>
      ) : null}
    </main>
  );
}

function Kpi({ value, text, tone }: { value: string | number; text: string; tone?: string }) {
  return (
    <div className="glass-chip rounded-2xl border border-border px-4 py-3">
      <strong className={`block font-display text-xl ${tone ?? ""}`}>{value}</strong>
      <small className="eyebrow-mono mt-1 block text-muted-foreground">{text}</small>
    </div>
  );
}

function Stat({ value, text, tone }: { value: string | number; text: string; tone?: string }) {
  return (
    <div className="glass-chip rounded-2xl border border-border px-3 py-2.5">
      <strong className={`block font-display text-lg capitalize ${tone ?? ""}`}>{value}</strong>
      <small className="eyebrow-mono mt-0.5 block text-muted-foreground">{text}</small>
    </div>
  );
}

function Bar({ text, value, className }: { text: string; value: number; className: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{text}</span><b className="text-foreground">{Math.round(value)}</b>
      </div>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2">
        <i className={`block h-full rounded-full transition-[width] duration-500 ${className}`} style={{ width: `${Math.min(100, value)}%` }} />
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
      <dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{value}</dd>
    </div>
  );
}

function Slide({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <article className="w-full shrink-0 snap-start" aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-sm font-semibold">{title}</h3>
        <em className="text-[11px] not-italic text-muted-foreground">{note}</em>
      </div>
      {children}
    </article>
  );
}
