"use client";

import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

export type MapLayer = "electric" | "water" | "facilities" | "serviceZones" | "dependencies" | "stormTrack" | "windExposure" | "floodExposure";
export type MapAssetRecord = {
  sgw_id: string; name: string; asset_type: string; latitude: number; longitude: number; operating_zone: string;
  hazard: { flood_depth_m: number; wind_gust_kph: number };
};
export type MapAssessment = { sgw_id: string; tier: string; risk_score: number; rank_change: number | null };
export type MapZone = { id: string; name: string; coordinates: Array<[number, number]> };
export type HazardArea = MapZone & { hazard: "flood" };
export type PositionedNode = { sgw_id: string; latitude: number; longitude: number };
export type HurricaneMap = {
  event_id: string; center: { latitude: number; longitude: number }; impact_radius_km: number;
  track: Array<{ stage: string; latitude: number; longitude: number }>;
};

type Props = {
  assets: MapAssetRecord[];
  assessments: Map<string, MapAssessment>;
  selectedId: string;
  selectedNodes: Map<string, PositionedNode>;
  selectedEdges: Array<{ from_id: string; to_id: string }>;
  operatingZones: MapZone[];
  hazardAreas: HazardArea[];
  hurricane: HurricaneMap | null;
  layers: Record<MapLayer, boolean>;
  biggestChanges: boolean;
  majorChanges: Set<string>;
  onSelect: (assetId: string) => void;
};

function layerFor(assetType: string): MapLayer {
  if (assetType === "substation") return "electric";
  if (assetType === "pump_station") return "water";
  return "facilities";
}

function glyph(assetType: string) {
  if (assetType === "substation") return "S";
  if (assetType === "pump_station") return "P";
  if (assetType === "water_zone") return "W";
  return "+";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

export default function OperationalMap({ assets, assessments, selectedId, selectedNodes, selectedEdges, operatingZones, hazardAreas, hurricane, layers, biggestChanges, majorChanges, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<LayerGroup | null>(null);
  const [leaflet, setLeaflet] = useState<typeof import("leaflet") | null>(null);
  const [tileUnavailable, setTileUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([32.94, -80.08], 9);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors", maxZoom: 18, crossOrigin: true,
      }).on("tileerror", () => setTileUnavailable(true)).addTo(map);
      mapRef.current = map;
      overlayRef.current = L.layerGroup().addTo(map);
      setLeaflet(L);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = leaflet; const map = mapRef.current; const overlay = overlayRef.current;
    if (!L || !map || !overlay) return;
    overlay.clearLayers();

    for (const zone of operatingZones) {
      const colors: Record<string, string> = { coastal: "#5d9fd6", inland_flood: "#55b8c9", inland_resilient: "#62c89b" };
      const polygon = L.polygon(zone.coordinates, { color: colors[zone.id] ?? "#82908d", weight: 1, dashArray: "5 7", fillOpacity: .035 });
      polygon.bindTooltip(zone.name, { permanent: true, direction: "center", className: "zone-label" });
      polygon.addTo(overlay);
    }
    if (layers.floodExposure) {
      for (const area of hazardAreas) L.polygon(area.coordinates, { color: "#4eb5d0", weight: 1, fillColor: "#26798b", fillOpacity: .18 }).bindTooltip(area.name).addTo(overlay);
    }
    if (hurricane && layers.windExposure) {
      L.circle([hurricane.center.latitude, hurricane.center.longitude], { radius: hurricane.impact_radius_km * 1000, color: "#78aef4", weight: 1, fillColor: "#4b79aa", fillOpacity: .10 }).bindTooltip(`Wind exposure · ${hurricane.impact_radius_km} km`).addTo(overlay);
    }
    if (hurricane && layers.stormTrack) {
      const points = hurricane.track.map((point) => [point.latitude, point.longitude] as [number, number]);
      L.polyline(points, { color: "#78aef4", weight: 2, dashArray: "4 7" }).addTo(overlay);
      for (const point of hurricane.track) L.circleMarker([point.latitude, point.longitude], { radius: 3, color: "#9ac6ff", fillOpacity: 1 }).bindTooltip(point.stage).addTo(overlay);
    }
    if (layers.serviceZones) {
      for (const asset of assets.filter((item) => item.asset_type === "water_zone")) {
        L.circle([asset.latitude, asset.longitude], { radius: 3000, color: "#52b8cc", weight: 1, dashArray: "4 5", fillColor: "#277889", fillOpacity: .09 }).bindTooltip(asset.name).addTo(overlay);
      }
    }
    if (layers.dependencies) {
      for (const edge of selectedEdges) {
        const from = selectedNodes.get(edge.from_id); const to = selectedNodes.get(edge.to_id);
        if (from && to) L.polyline([[from.latitude, from.longitude], [to.latitude, to.longitude]], { color: "#69a9ff", weight: 2, opacity: .8 }).addTo(overlay);
      }
    }
    for (const asset of assets) {
      const assessment = assessments.get(asset.sgw_id); if (!assessment) continue;
      if (asset.asset_type === "water_zone" || !layers[layerFor(asset.asset_type)]) continue;
      const selected = asset.sgw_id === selectedId; const changed = majorChanges.has(asset.sgw_id);
      const dimmed = biggestChanges && !changed && !selected;
      const marker = L.marker([asset.latitude, asset.longitude], {
        opacity: dimmed ? .2 : 1,
        icon: L.divIcon({
          className: "sgw-leaflet-icon",
          html: `<span class="leaflet-asset leaflet-asset--${assessment.tier}${selected ? " leaflet-asset--selected" : ""}${changed ? " leaflet-asset--changed" : ""}">${glyph(asset.asset_type)}</span>`,
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
      });
      marker.bindTooltip(`<strong>${escapeHtml(asset.sgw_id.replace("SGW-", ""))}</strong> · ${escapeHtml(asset.name)}<br><span>${assessment.tier.toUpperCase()} · Risk ${Math.round(assessment.risk_score)}</span><br><small>Wind ${Math.round(asset.hazard.wind_gust_kph)} km/h · Flood ${asset.hazard.flood_depth_m.toFixed(2)} m</small>`, { direction: "top", offset: [0, -10] });
      marker.on("click", () => onSelect(asset.sgw_id)).addTo(overlay);
    }
  }, [assets, assessments, biggestChanges, hazardAreas, hurricane, layers, leaflet, majorChanges, onSelect, operatingZones, selectedEdges, selectedId, selectedNodes]);

  return <div className="leaflet-map-shell"><div ref={containerRef} className="leaflet-map" aria-label="SGW coastal and inland infrastructure map" />{tileUnavailable && <div className="tile-fallback" role="status"><strong>Context map unavailable</strong><span>SGW assets and hazard overlays remain operational.</span></div>}</div>;
}
