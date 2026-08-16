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
  const { lastUpdated, dataFreshness, refreshing, error } = useIncident();
  function navigate(event: React.MouseEvent<HTMLAnchorElement>, destination: string) {
    event.preventDefault();
    window.location.assign(contextualHref(destination));
  }
  return <><nav className="workflow-nav" aria-label="SGW workflow navigation">
    <Link className="workflow-brand" href="/" onClick={(event) => navigate(event, "/")} aria-label="SGW Risk Overview"><span>SGW</span><small>RI</small></Link>
    <div className="workflow-links">{destinations.map((item) => {
      const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
      return <a key={item.href} href={item.href} onClick={(event) => navigate(event, item.href)} className={active ? "active" : ""} aria-current={active ? "page" : undefined} title={`${item.phase}: ${item.label}`}><small>{item.short}</small><span>{item.label}</span><i>{item.phase}</i></a>;
    })}</div>
    <div className="workflow-flow">{refreshing ? <strong>Updating assessment…</strong> : error ? <strong>State refresh delayed</strong> : <><span>Updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "—"}</span><small>Weather {dataFreshness?.weather ?? "—"}m · Field Ops {dataFreshness?.field_ops ?? "—"}m</small></>}<i>Assess → Respond → Inform</i></div>
  </nav><style>{`.workflow-nav{position:fixed;z-index:10000;inset:0 auto 0 0;width:116px;display:flex;flex-direction:column;border-right:1px solid #27302f;background:#070b0b;color:#eef2f1;font-family:Arial,sans-serif}.workflow-brand{height:66px;display:flex;align-items:center;justify-content:center;gap:5px;border-bottom:1px solid #27302f;color:#eef2f1;text-decoration:none}.workflow-brand span{font:700 15px monospace;letter-spacing:.08em}.workflow-brand small{padding:2px 3px;border:1px solid #446c98;color:#69a9ff;font:600 6px monospace}.workflow-links{padding:14px 0}.workflow-links a{position:relative;display:grid;grid-template-columns:22px 1fr;gap:5px;align-items:center;min-height:57px;padding:9px 9px;border-left:2px solid transparent;color:#879391;text-decoration:none}.workflow-links a:hover{background:#0d1414;color:#f2f4f3}.workflow-links a.active{border-left-color:#69a9ff;background:#101818;color:#f2f4f3}.workflow-links small{color:#56605f;font:7px monospace}.workflow-links span{font-size:9px;font-weight:600;line-height:1.25}.workflow-links i{grid-column:2;color:#56605f;font:normal 7px monospace;text-transform:uppercase}.workflow-flow{margin-top:auto;padding:15px 12px 18px;border-top:1px solid #27302f;color:#56605f;text-align:center;font:7px monospace;text-transform:uppercase}.workflow-flow span,.workflow-flow b{display:block;margin:5px 0}.workflow-flow b{color:#3c628e}@media(max-width:760px){.workflow-nav{inset:auto 0 0 0;width:auto;height:58px;flex-direction:row;border-right:0;border-top:1px solid #27302f}.workflow-brand,.workflow-flow{display:none}.workflow-links{display:grid;grid-template-columns:repeat(4,1fr);width:100%;padding:0}.workflow-links a{display:flex;justify-content:center;min-height:57px;padding:7px;border-left:0;border-top:2px solid transparent}.workflow-links a.active{border-left:0;border-top-color:#69a9ff}.workflow-links small,.workflow-links i{display:none}.workflow-links span{font-size:8px}body{padding-bottom:58px!important}}`}</style></>;
}
