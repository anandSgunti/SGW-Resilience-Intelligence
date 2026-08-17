"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

export type SharedIncidentState = { advisory: { advisory_id: string; event_id: string; stage: string; issued_at: string }; summary: { open_actions: number }; responses: Array<{ status: string }>; [key: string]: unknown };
type RefreshReason = "advisory_change" | "human_action" | "field_evidence" | "manual";
type IncidentValue = { currentAdvisory: string; currentEvent: string | null; selectedAsset: string | null; lastUpdated: Date | null; activeResponseState: { open: number; active: number; completed: number }; lastRefreshReason: RefreshReason; state: SharedIncidentState | null; refreshing: boolean; error: string | null; setCurrentAdvisory: (value: string) => void; setSelectedAsset: (value: string | null) => void; refreshIncident: (advisory?: string, reason?: RefreshReason) => Promise<SharedIncidentState> };
const API = process.env.NEXT_PUBLIC_SGW_API_URL ?? "http://127.0.0.1:8000";
const IncidentContext = createContext<IncidentValue | null>(null);

export function IncidentProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  // Seeded during render from the URL the server already knows.
  const [currentAdvisory, setCurrentAdvisory] = useState(() => searchParams?.get("t") ?? "T-24");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(() => searchParams?.get("asset") ?? null);
  const [state, setState] = useState<SharedIncidentState | null>(null); const [lastUpdated, setLastUpdated] = useState<Date | null>(null); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<{ advisory: string; request: Promise<SharedIncidentState> } | null>(null);
  const [lastReason, setLastReason] = useState<RefreshReason>("manual");
  const refreshIncident = useCallback(async (advisory = currentAdvisory, reason: RefreshReason = "manual") => { if (inFlight.current?.advisory === advisory) return inFlight.current.request; const request = (async () => { setRefreshing(true); setError(null); setLastReason(reason); try { const response = await fetch(`${API}/api/state?t=${encodeURIComponent(advisory)}`); if (!response.ok) throw new Error(`Incident refresh failed (${response.status})`); const payload = await response.json() as SharedIncidentState; setState(payload); setLastUpdated(new Date()); return payload; } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Incident state unavailable"); throw requestError; } finally { setRefreshing(false); inFlight.current = null; } })(); inFlight.current = { advisory, request }; return request; }, [currentAdvisory]);
  useEffect(() => { void refreshIncident(currentAdvisory, "advisory_change").catch(() => undefined); }, [currentAdvisory, refreshIncident]);
  const activeResponseState = useMemo(() => ({ open: state?.summary.open_actions ?? 0, active: state?.responses.filter((item) => ["assigned", "in_progress"].includes(item.status)).length ?? 0, completed: state?.responses.filter((item) => item.status === "completed").length ?? 0 }), [state]);
  const value = useMemo(() => ({ currentAdvisory, currentEvent: state?.advisory.event_id ?? null, selectedAsset, lastUpdated, activeResponseState, lastRefreshReason: lastReason, state, refreshing, error, setCurrentAdvisory, setSelectedAsset, refreshIncident }), [activeResponseState, currentAdvisory, error, lastReason, lastUpdated, refreshIncident, refreshing, selectedAsset, state]);
  return <IncidentContext.Provider value={value}>{children}</IncidentContext.Provider>;
}

export function useIncident() { const value = useContext(IncidentContext); if (!value) throw new Error("useIncident must be used inside IncidentProvider"); return value; }
