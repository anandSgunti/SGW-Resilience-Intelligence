"use client";

import { usePathname } from "next/navigation";
import { useIncident } from "./IncidentContext";
import Link from "next/link";

const destinations = [
  { href: "/", label: "Risk Overview", short: "01", phase: "Assess" },
  { href: "/asset-risk", label: "Asset Risk", short: "02", phase: "Assess" },
  { href: "/respond", label: "Response", short: "03", phase: "Respond" },
  { href: "/leadership", label: "Leadership", short: "04", phase: "Inform" },
];

const preservedKeys = ["t", "asset", "region", "filter", "railFilter", "railMode"];

/** HURRICANE-IRIS -> Hurricane Iris */
function eventName(id: string | null) {
  if (!id) return null;
  return id.split("-").map((part) => part[0] + part.slice(1).toLowerCase()).join(" ");
}

function contextualHref(destination: string) {
  const current = new URLSearchParams(window.location.search);
  const next = new URLSearchParams();
  for (const key of preservedKeys) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  const suffix = next.toString();
  return suffix ? `${destination}?${suffix}` : destination;
}

export default function WorkflowNav() {
  const pathname = usePathname();
  const { lastUpdated, refreshing, error, currentEvent, currentAdvisory, state } = useIncident();
  const advisory = state?.advisory as { storm_category?: number } | undefined;
  const storm = advisory?.storm_category;
  function navigate(event: React.MouseEvent<HTMLAnchorElement>, destination: string) {
    event.preventDefault();
    window.location.assign(contextualHref(destination));
  }
  return <><nav className="workflow-nav" aria-label="SGW workflow navigation">
    <Link className="workflow-brand" href="/" onClick={(event) => navigate(event, "/")} aria-label="SGW Risk Overview"><i aria-hidden="true">SGW</i><span>Resilience command</span></Link>
    <div className="workflow-links">{destinations.map((item) => {
      const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
      return <a key={item.href} href={item.href} onClick={(event) => navigate(event, item.href)} className={active ? "active" : ""} aria-current={active ? "page" : undefined}><span>{item.label}</span><i>{item.phase}</i></a>;
    })}</div>
    <div className="workflow-state">
      <span className="workflow-chip workflow-chip--event"><i aria-hidden="true" />
        <b>{eventName(currentEvent) ?? "Hurricane Iris"}</b>
        {storm ? ` · Category ${storm}` : ""} · {currentAdvisory}
      </span>
      {refreshing ? <span className="workflow-chip workflow-chip--busy">Updating assessment…</span>
        : error ? <span className="workflow-chip workflow-chip--warn">State refresh delayed</span>
        : <span className="workflow-chip">Updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "—"}</span>}
    </div>
  </nav><style>{`
.workflow-nav{position:sticky;top:0;z-index:10000;display:flex;align-items:center;gap:28px;height:56px;padding:0 24px;
  background:rgba(255,255,255,.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);
  border-bottom:1px solid #d2d2d7;color:#1d1d1f;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif}
.workflow-brand{display:flex;align-items:center;gap:8px;color:#1d1d1f;text-decoration:none;font-size:15px;font-weight:600;letter-spacing:-.01em}
.workflow-brand i{width:24px;height:24px;display:grid;place-items:center;border-radius:6px;background:#1d1d1f;color:#fff;font-style:normal;font:700 9px/1 ui-monospace,monospace}
.workflow-links{display:flex;align-items:center;gap:4px}
.workflow-links a{position:relative;display:flex;flex-direction:column;gap:1px;padding:7px 12px;border-radius:8px;
  color:#6e6e73;text-decoration:none;transition:background .2s cubic-bezier(.32,.72,0,1),color .2s}
.workflow-links a:hover{background:rgba(120,120,128,.10);color:#1d1d1f}
.workflow-links a:focus-visible{outline:2px solid #007aff;outline-offset:2px}
.workflow-links a.active{color:#1d1d1f}
.workflow-links a.active:after{content:"";position:absolute;left:12px;right:12px;bottom:-9px;height:2px;border-radius:2px;background:#007aff}
.workflow-links span{font-size:14px;font-weight:500;line-height:1.2}
.workflow-links a.active span{font-weight:590}
.workflow-links i{color:#8e8e93;font-style:normal;font-size:10px;font-weight:500;letter-spacing:.04em;text-transform:uppercase}
.workflow-state{margin-left:auto;display:flex;align-items:center;gap:8px}
.workflow-chip{padding:5px 12px;border-radius:999px;background:#f2f2f7;color:#6e6e73;font-size:13px;white-space:nowrap}
.workflow-chip--event{display:flex;align-items:center;gap:7px;color:#1d1d1f}
.workflow-chip--event b{font-weight:590}
.workflow-chip--event i{width:7px;height:7px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.16)}
.workflow-chip--busy{background:rgba(0,122,255,.12);color:#0071e3}
.workflow-chip--warn{background:rgba(255,149,0,.14);color:#c76b00}
@media(max-width:820px){
  .workflow-nav{gap:12px;padding:0 12px;overflow-x:auto}
  .workflow-links i{display:none}
  .workflow-state{display:none}
}
`}</style></>;
}
