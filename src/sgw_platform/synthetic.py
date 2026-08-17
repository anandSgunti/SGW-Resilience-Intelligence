from __future__ import annotations

import json
import random
from pathlib import Path


SEED = 42
ADVISORIES = [
    ("ADV-T72", "T-72 hours", 0.68), ("ADV-T48", "T-48 hours", 0.76),
    ("ADV-T24", "T-24 hours", 0.90), ("ADV-T12", "T-12 hours", 0.96),
    ("ADV-T0", "Landfall", 0.84),
]

AUTHORED_LOCATIONS = {
    # Fictional US Atlantic service territory. Coordinates are plausible but
    # do not represent a real utility network or real asset locations.
    # Coastal operations: wind and surge exposure.
    "SGW-S17": (32.735, -79.860), "SGW-P4": (32.770, -79.900), "SGW-W12": (32.810, -79.950),
    "SGW-H3": (32.823, -79.960), "SGW-F2": (32.798, -79.935), "SGW-S10": (32.845, -79.985),
    "SGW-P5": (32.830, -79.970),
    # Inland rainfall/flooding: direct water-asset exposure.
    "SGW-S14": (33.145, -80.060), "SGW-P11": (33.110, -80.080), "SGW-W03": (33.060, -80.120),
    "SGW-D1": (33.050, -80.130), "SGW-S06": (33.105, -80.155), "SGW-P3": (33.080, -80.140),
    "SGW-S16": (33.160, -80.145), "SGW-P12": (33.125, -80.130),
    # Inland resilient: high vulnerability, but alternate supply and long backup.
    "SGW-S31": (33.050, -80.360), "SGW-P9": (33.010, -80.310), "SGW-W07": (32.970, -80.280),
    "SGW-PS1": (32.955, -80.270), "SGW-S05": (33.035, -80.295), "SGW-S11": (32.925, -80.320),
    "SGW-P6": (32.945, -80.300),
}

ZONE_HAZARD = {
    "coastal": {"wind": 0.70, "flood": 0.88},
    "inland_flood": {"wind": 0.56, "flood": 1.00},
    "inland_resilient": {"wind": 0.82, "flood": 0.22},
    "lower_exposure": {"wind": 0.42, "flood": 0.18},
}


def _operating_zone(latitude: float, longitude: float) -> str:
    """Classify synthetic coordinates into application-owned operating zones."""
    if longitude >= -80.00:
        return "coastal"
    if latitude >= 32.98 and longitude >= -80.20:
        return "inland_flood"
    if longitude <= -80.22:
        return "inland_resilient"
    return "lower_exposure"


def build_synthetic_payload(seed: int = SEED) -> dict:
    rng = random.Random(seed)
    assets: list[dict] = []
    dependencies: list[dict] = []

    def asset(sgw_id: str, kind: str, name: str, *, condition=70, baseline=.14, exposure=.5, attrs=None):
        index = len(assets)
        domain = "electric" if kind == "substation" else "water" if kind in {"pump_station", "water_zone"} else "community"
        latitude, longitude = AUTHORED_LOCATIONS.get(
            sgw_id,
            (round(32.72 + rng.random() * .46, 6), round(-80.45 + rng.random() * .58, 6)),
        )
        operating_zone = _operating_zone(latitude, longitude)
        attributes = {"operating_zone": operating_zone, **(attrs or {})}
        assets.append({"sgw_id": sgw_id, "asset_type": kind, "name": name,
                       "domain": domain,
                       "source_ids": {"electric_registry" if kind == "substation" else "water_ops": f"{kind[:2].upper()}-{1000 + index}", "legacy_gis": f"GIS/{sgw_id[4:]}"},
                       "latitude": latitude, "longitude": longitude,
                       "condition_score": condition, "disruption_baseline": baseline,
                       "storm_exposure": exposure, "service_region": "SGW-NORTH" if index % 2 else "SGW-CENTRAL",
                       "last_inspection_date": f"2026-0{rng.randint(1, 6)}-{rng.randint(10, 28)}", "open_work_orders": rng.randint(0, 3), "attributes": attributes})

    # Authored clusters: data characteristics, not assessment-engine exceptions.
    asset("SGW-S17", "substation", "Substation S17", condition=78, baseline=.32, exposure=.70, attrs={"coastal_flood_exposure": True})
    asset("SGW-S31", "substation", "Substation S31", condition=40, baseline=.37, exposure=.82, attrs={"intrinsic_criticality": 1.0})
    asset("SGW-S08", "substation", "Substation S08", condition=63, baseline=.25, exposure=.65)
    asset("SGW-S12", "substation", "Substation S12", condition=81, baseline=.11, exposure=.42)
    for number in ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S09", "S10", "S11", "S13", "S14", "S15", "S16"]:
        asset(f"SGW-{number}", "substation", f"Substation {number}", condition=rng.randint(48, 90), baseline=round(rng.uniform(.07, .25), 2), exposure=round(rng.uniform(.25, .78), 2))

    asset("SGW-P4", "pump_station", "Pump Station P4", condition=74, baseline=.18, exposure=.55, attrs={"backup_endurance_hours": 6})
    asset("SGW-P9", "pump_station", "Pump Station P9", condition=83, baseline=.12, exposure=.40, attrs={"backup_endurance_hours": 18})
    asset("SGW-P7", "pump_station", "Pump Station P7", condition=80, baseline=.12, exposure=.40, attrs={"backup_endurance_hours": 8})
    asset("SGW-P11", "pump_station", "Pump Station P11", condition=67, baseline=.20, exposure=.71, attrs={"flood_sensitive": True, "backup_endurance_hours": 4})
    backup_hours = {"P1": 12, "P2": 8, "P3": 6, "P5": 10, "P6": 12, "P8": 10, "P10": 10, "P12": 8}
    for number in ["P1", "P2", "P3", "P5", "P6", "P8", "P10", "P12"]:
        asset(f"SGW-{number}", "pump_station", f"Pump Station {number}", condition=rng.randint(50, 91), baseline=round(rng.uniform(.08, .25), 2), exposure=round(rng.uniform(.22, .75), 2), attrs={"backup_endurance_hours": backup_hours[number]})

    asset("SGW-W12", "water_zone", "Water Service Zone W12", attrs={"population": 84000})
    asset("SGW-W07", "water_zone", "Water Service Zone W07", attrs={"population": 28000})
    asset("SGW-W09", "water_zone", "Water Service Zone W09", attrs={"population": 52000})
    asset("SGW-W03", "water_zone", "Water Service Zone W03", attrs={"population": 41000})
    asset("SGW-W15", "water_zone", "Water Service Zone W15", attrs={"population": 33000})
    asset("SGW-H3", "hospital", "Hospital H3", attrs={"beds": 410})
    asset("SGW-F2", "fire_station", "Fire Station F2", attrs={"appliances": 6})
    asset("SGW-E1", "emergency_operations_centre", "Emergency Operations Centre E1")
    asset("SGW-D1", "dialysis_centre", "Dialysis Centre D1")
    asset("SGW-PS1", "police_station", "Police Station PS1")

    def link(from_id, to_id, rel, **kw): dependencies.append({"from_id": from_id, "to_id": to_id, "relationship": rel, **kw})
    link("SGW-S17", "SGW-P4", "powers", backup_endurance_hours=6); link("SGW-P4", "SGW-W12", "serves", capacity_share=.70)
    link("SGW-W12", "SGW-H3", "located_in", dependency_class="service_consequence")
    link("SGW-W12", "SGW-F2", "located_in", dependency_class="service_consequence", verified=True, confidence=.68, source="inferred_service_registry", last_validated="2026-06-18")
    link("SGW-S10", "SGW-P5", "powers", backup_endurance_hours=10); link("SGW-P5", "SGW-W12", "serves", capacity_share=.30)
    link("SGW-S31", "SGW-P9", "powers", redundancy_group="P9-feeds"); link("SGW-S05", "SGW-P9", "backup_feed", redundancy_group="P9-feeds", capacity_share=.30); link("SGW-P9", "SGW-W07", "serves", capacity_share=1.0)
    link("SGW-S11", "SGW-P6", "powers"); link("SGW-P6", "SGW-W07", "serves", capacity_share=.40)
    link("SGW-S08", "SGW-P7", "powers", redundancy_group="P7-feeds"); link("SGW-S12", "SGW-P7", "backup_feed", redundancy_group="P7-feeds", capacity_share=1.0); link("SGW-P7", "SGW-W09", "serves", capacity_share=.65)
    link("SGW-S13", "SGW-P8", "powers"); link("SGW-P8", "SGW-W09", "serves", capacity_share=.35)
    link("SGW-S02", "SGW-P1", "powers"); link("SGW-P1", "SGW-W15", "serves", capacity_share=.34)
    link("SGW-S03", "SGW-P2", "powers"); link("SGW-P2", "SGW-W15", "serves", capacity_share=.33)
    link("SGW-S06", "SGW-P3", "powers"); link("SGW-P3", "SGW-W03", "serves", capacity_share=.25)
    link("SGW-S15", "SGW-P10", "powers"); link("SGW-P10", "SGW-W15", "serves", capacity_share=.33)
    link("SGW-S14", "SGW-P11", "powers"); link("SGW-P11", "SGW-W03", "serves", capacity_share=.50)
    link("SGW-S16", "SGW-P12", "powers"); link("SGW-P12", "SGW-W03", "serves", capacity_share=.25)
    link("SGW-W09", "SGW-E1", "located_in", dependency_class="service_consequence")
    link("SGW-W03", "SGW-D1", "located_in", dependency_class="service_consequence")
    link("SGW-W07", "SGW-PS1", "located_in", dependency_class="service_consequence")

    track_coordinates = [(31.90, -78.70), (32.25, -79.15), (32.55, -79.60), (32.78, -79.90), (33.00, -80.18)]
    storm_track = [
        {"stage": label.replace(" hours", ""), "latitude": track_coordinates[index][0], "longitude": track_coordinates[index][1]}
        for index, (_, label, _) in enumerate(ADVISORIES)
    ]
    advisories = [{"advisory_id": aid, "issued_at": f"2026-09-0{index + 1}T08:00:00Z", "label": label, "storm_severity": severity,
                   "event_id": "HURRICANE-IRIS", "stage": label.replace(" hours", ""), "storm_category": 2 if severity < .8 else 3,
                   "wind_severity": severity, "rainfall_severity": round(severity * .9, 2), "flood_severity": round(severity * 1.05, 2),
                   "storm_center_latitude": storm_track[index]["latitude"], "storm_center_longitude": storm_track[index]["longitude"],
                   "impact_radius_km": round(28 + severity * 24, 1), "storm_track": storm_track,
                   "changes": []} for index, (aid, label, severity) in enumerate(ADVISORIES)]
    for advisory in advisories:
        if advisory["advisory_id"] == "ADV-T72":
            advisory["changes"] = [{"type": "weather_watch", "field": "forecast_cone", "current": "broad"}]
        elif advisory["advisory_id"] == "ADV-T48":
            advisory["changes"] = [{"type": "weather_update", "area": "SGW-NORTH", "field": "track_proximity", "current": "increased"}, {"type": "field_update", "asset_id": "SGW-S17", "field": "restoration_hours", "current": 4}]
        elif advisory["advisory_id"] == "ADV-T24":
            advisory["changes"] = [{"type": "field_update", "asset_id": "SGW-S17", "field": "restoration_hours", "previous": 4, "current": 14}, {"type": "weather_update", "area": "SGW-NORTH", "field": "forecast_confidence", "current": "high"}]
        elif advisory["advisory_id"] == "ADV-T12":
            advisory["changes"] = [{"type": "weather_update", "asset_id": "SGW-P11", "field": "flood_exposure", "current": "increased"}, {"type": "verification", "asset_id": "SGW-P4", "field": "generator_status", "current": "verified_operational"}]
        elif advisory["advisory_id"] == "ADV-T0":
            advisory["changes"] = [{"type": "response_update", "asset_id": "SGW-P4", "field": "temporary_generation", "current": "in_progress"}, {"type": "response_update", "asset_id": "SGW-S17", "field": "priority_inspection", "current": "approved"}]
    states = []
    for advisory in advisories:
        for item in assets:
            zone = item["attributes"]["operating_zone"]
            zone_hazard = ZONE_HAZARD[zone]
            local_wind_exposure = (item["storm_exposure"] + zone_hazard["wind"]) / 2
            flood = round(max(0, advisory["flood_severity"] * zone_hazard["flood"] * rng.uniform(.35, .72)), 2)
            if item["sgw_id"] == "SGW-P11": flood = round(flood + advisory["storm_severity"] * .34, 2)
            if item["sgw_id"] == "SGW-P11" and advisory["advisory_id"] in {"ADV-T12", "ADV-T0"}: flood = round(flood + .45, 2)
            restoration = round(2 + advisory["storm_severity"] * 14 * item["storm_exposure"], 1)
            if item["sgw_id"] == "SGW-S17" and advisory["advisory_id"] in {"ADV-T72", "ADV-T48"}: restoration = 4
            if item["sgw_id"] == "SGW-S17" and advisory["advisory_id"] in {"ADV-T24", "ADV-T12", "ADV-T0"}: restoration = 14
            is_pump = item["asset_type"] == "pump_station"
            verification = "unverified" if item["sgw_id"] == "SGW-P4" and advisory["advisory_id"] not in {"ADV-T12", "ADV-T0"} else "verified"
            wind_gust = round(35 + advisory["storm_severity"] * 95 * local_wind_exposure, 1)
            # At T-48 the broad forecast cone places three other service assets
            # ahead of S17 on direct exposure. The later field restoration update,
            # rather than a rank override, is what moves S17 to the top at T-24.
            if advisory["advisory_id"] == "ADV-T48" and item["sgw_id"] in {"SGW-P4", "SGW-W12", "SGW-W09"}:
                wind_gust = 150.0
            states.append({"advisory_id": advisory["advisory_id"], "sgw_id": item["sgw_id"], "flood_depth_m": flood,
                           "wind_gust_kph": wind_gust,
                           "restoration_hours": restoration, "generator_status": "operational" if is_pump else "not_applicable",
                           "backup_available_hours": item["attributes"].get("backup_endurance_hours") if is_pump else None,
                           "verification_status": verification, "reported_at": advisory["issued_at"], "reported_by": "Field Operations", "source": "field_ops"})
    source_data = {"gis": [], "maintenance": [], "field_ops": []}
    for item in assets:
        # The records intentionally use independent source identifiers; their shared
        # canonical ID is reconciliation metadata owned by the adapter boundary.
        for provider, source_id in item["source_ids"].items():
            provider_group = "gis" if provider == "legacy_gis" else "maintenance"
            source_data[provider_group].append({"source_id": source_id, "canonical_sgw_id": item["sgw_id"]})
        source_data["field_ops"].append({"source_id": f"OPS-{item['sgw_id'][4:]}", "canonical_sgw_id": item["sgw_id"]})
    return {"metadata": {"dataset": "SGW synthetic network", "seed": seed, "schema_version": "1.2"}, "source_data": source_data, "assets": assets, "dependencies": dependencies, "advisories": advisories, "states": states}


def write_synthetic_data(path: str | Path, seed: int = SEED) -> Path:
    destination = Path(path)
    payload = build_synthetic_payload(seed)
    destination.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    sources_dir = destination.parent / "sources"
    sources_dir.mkdir(exist_ok=True)
    for provider, records in payload["source_data"].items():
        (sources_dir / f"{provider}.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    (sources_dir / "weather_advisories.json").write_text(json.dumps(payload["advisories"], indent=2), encoding="utf-8")
    (sources_dir / "field_updates.json").write_text(json.dumps(payload["states"], indent=2), encoding="utf-8")
    (sources_dir / "dependencies.json").write_text(json.dumps(payload["dependencies"], indent=2), encoding="utf-8")
    return destination
