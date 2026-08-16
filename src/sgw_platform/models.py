from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class AssetType(StrEnum):
    SUBSTATION = "substation"
    PUMP_STATION = "pump_station"
    WATER_ZONE = "water_zone"
    HOSPITAL = "hospital"
    FIRE_STATION = "fire_station"
    EMERGENCY_OPERATIONS_CENTRE = "emergency_operations_centre"
    DIALYSIS_CENTRE = "dialysis_centre"
    POLICE_STATION = "police_station"


class RelationshipType(StrEnum):
    POWERS = "powers"
    SERVES = "serves"
    LOCATED_IN = "located_in"
    BACKUP_FEED = "backup_feed"


class RiskTier(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    MODERATE = "medium"  # Backwards-compatible alias.
    HIGH = "high"
    CRITICAL = "critical"


class LikelihoodBand(StrEnum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    VERY_HIGH = "very_high"


class ConfidenceLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class RecommendationStatus(StrEnum):
    RECOMMENDED = "recommended"
    APPROVED = "approved"
    REJECTED = "rejected"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class BriefingStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"


class ActionClass(StrEnum):
    """What kind of work a recommendation represents, independent of rule id."""

    FIELD_VERIFICATION = "field_verification"
    MITIGATION = "mitigation"
    ESCALATION = "escalation"
    PROTECTION = "protection"


class FieldOutcome(StrEnum):
    """Result a field team can record against a verification action."""

    VERIFIED_OPERATIONAL = "verified_operational"
    VERIFIED_DEGRADED = "verified_degraded"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class RecommendationFact:
    metric: str
    value: Any
    unit: str | None = None


@dataclass(frozen=True)
class RecommendationEvent:
    status: RecommendationStatus
    occurred_at: str
    actor: str
    owner: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class RuleThreshold:
    """One configured limit, in operator language rather than code."""

    label: str
    value: str


@dataclass(frozen=True)
class PlaybookRule:
    """Published, versioned description of a playbook rule.

    `summary` and `thresholds` are the only rule internals ever exposed. Raw
    predicates stay in `PlaybookEngine`; bump `version` when the logic changes.
    """

    rule_id: str
    version: str
    name: str
    summary: str
    action_class: ActionClass
    default_owner: str
    thresholds: tuple[RuleThreshold, ...] = ()

    @property
    def label(self) -> str:
        return f"Playbook {self.rule_id} · {self.name}"


@dataclass(frozen=True)
class TriggerCondition:
    """The comparison that made a rule fire, rendered without code."""

    summary: str
    left_label: str
    left_value: Any
    operator: str
    right_label: str
    right_value: Any
    unit: str | None = None


@dataclass(frozen=True)
class RecommendationEvidence:
    """Why this recommendation exists, and which inputs produced it."""

    trigger: tuple[TriggerCondition, ...]
    impact_items: tuple[str, ...]
    impact_summary: str
    assessment_source: str
    advisory_id: str
    assessed_tier: RiskTier
    assessed_risk_score: float
    state_reported_at: str | None = None


@dataclass(frozen=True)
class Recommendation:
    recommendation_id: str
    rule_id: str
    asset_id: str
    target_asset_id: str | None
    advisory_id: str
    title: str
    reason: str
    facts: tuple[RecommendationFact, ...]
    priority: RiskTier
    default_owner: str
    action_class: ActionClass = ActionClass.MITIGATION
    rule: PlaybookRule | None = None
    evidence: RecommendationEvidence | None = None
    status: RecommendationStatus = RecommendationStatus.RECOMMENDED
    owner: str | None = None
    history: tuple[RecommendationEvent, ...] = ()

    @property
    def rule_version(self) -> str:
        return self.rule.version if self.rule else "unversioned"


@dataclass(frozen=True)
class LeadershipBriefing:
    briefing_id: str
    advisory_id: str
    version: int
    text: str
    fact_pack_sha256: str
    model: str
    status: BriefingStatus = BriefingStatus.DRAFT
    created_at: str | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    final_text: str | None = None


@dataclass(frozen=True)
class ConfidenceComponent:
    name: str
    score: float
    detail: str


@dataclass(frozen=True)
class ConfidenceAssessment:
    advisory_id: str
    sgw_id: str
    score: float
    level: ConfidenceLevel
    sufficient_data: bool
    components: tuple[ConfidenceComponent, ...]
    reasons: tuple[str, ...]
    verification_actions: tuple[str, ...]


@dataclass(frozen=True)
class RiskDriver:
    metric: str
    label: str
    value: Any
    unit: str | None
    impact: str


@dataclass(frozen=True)
class ChangeDriver:
    metric: str
    previous: Any
    current: Any
    unit: str | None
    impact: str
    summary: str


@dataclass(frozen=True)
class GeneratedExplanation:
    text: str
    model: str
    fact_pack_sha256: str
    grounded: bool


@dataclass(frozen=True)
class LikelihoodComponent:
    name: str
    points: float
    detail: str


@dataclass(frozen=True)
class LikelihoodAssessment:
    advisory_id: str
    sgw_id: str
    score: float
    raw_score: float
    band: LikelihoodBand
    components: tuple[LikelihoodComponent, ...]
    drivers: tuple[str, ...]


@dataclass(frozen=True)
class ConsequencePath:
    source_id: str
    service_asset_id: str
    zone_id: str
    population: int
    effective_population: int
    critical_facilities: tuple[str, ...]
    critical_facility_ids: tuple[str, ...]
    restoration_hours: float
    backup_hours: float
    uncovered_hours: float
    duration_severity: str
    duration_factor: float
    resilience_factor: float
    capacity_lost: float
    exposure_score: float
    adjusted_impact: float


@dataclass(frozen=True)
class ConsequenceAssessment:
    advisory_id: str
    sgw_id: str
    score: float
    raw_score: float
    base_consequence: float
    affected_population: int
    effective_population: int
    critical_facilities: tuple[str, ...]
    max_uncovered_hours: float
    paths: tuple[ConsequencePath, ...]
    drivers: tuple[str, ...]
    critical_facility_ids: tuple[str, ...] = ()
    impacted_zone_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Asset:
    """Stable canonical identity and slow-changing engineering characteristics."""

    sgw_id: str
    asset_type: AssetType
    name: str
    domain: str
    source_ids: dict[str, str]
    latitude: float
    longitude: float
    condition_score: int  # 0 (poor) to 100 (excellent)
    disruption_baseline: float
    storm_exposure: float
    service_region: str = "SGW-NORTH"
    last_inspection_date: str | None = None
    open_work_orders: int = 0
    attributes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["asset_type"] = self.asset_type.value
        return result


@dataclass(frozen=True)
class Advisory:
    advisory_id: str
    issued_at: str
    label: str
    storm_severity: float  # 0–1, advisory-wide meteorological intensity
    event_id: str = "HURRICANE-IRIS"
    stage: str = "T-24"
    storm_category: int = 2
    wind_severity: float = 0.0
    rainfall_severity: float = 0.0
    flood_severity: float = 0.0
    storm_center_latitude: float = 0.0
    storm_center_longitude: float = 0.0
    impact_radius_km: float = 0.0
    storm_track: tuple[dict[str, Any], ...] = ()
    data_freshness_minutes: dict[str, int] = field(default_factory=dict)
    changes: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class AssetState:
    """Observations/predictions scoped to exactly one asset and advisory."""

    advisory_id: str
    sgw_id: str
    flood_depth_m: float
    wind_gust_kph: float
    restoration_hours: float
    operational_status: str = "operational"
    generator_status: str = "not_applicable"
    backup_available_hours: float | None = None
    verification_status: str = "unverified"
    reported_at: str | None = None
    reported_by: str | None = None
    source: str | None = None


@dataclass(frozen=True)
class Dependency:
    from_id: str
    to_id: str
    relationship: RelationshipType
    redundancy_group: str | None = None
    backup_endurance_hours: float | None = None
    dependency_class: str = "infrastructure"
    confidence: float = 0.9
    verified: bool = True
    source: str = "synthetic_dependency_registry"
    last_validated: str = "2026-08-01"
    capacity_share: float | None = None


@dataclass(frozen=True)
class Assessment:
    advisory_id: str
    sgw_id: str
    disruption_likelihood: float
    consequence_score: float
    risk_score: float
    tier: RiskTier
    affected_population: int
    critical_facilities: tuple[str, ...]
    explanations: tuple[str, ...]
    confidence: str = "medium"
    confidence_score: float = 0.0
    confidence_reasons: tuple[str, ...] = ()
    sufficient_data: bool = True
    verification_actions: tuple[str, ...] = ()
    restoration_hours: float = 0.0
    flood_depth_m: float = 0.0
    direct_flood_sensitive: bool = False
    max_uncovered_hours: float = 0.0
    limiting_backup_hours: float = 0.0
    limiting_service_id: str | None = None
    impacted_zone_ids: tuple[str, ...] = ()
    critical_facility_ids: tuple[str, ...] = ()
    material_verification: tuple[tuple[str, str], ...] = ()
    current_drivers: tuple[RiskDriver, ...] = ()
    change_drivers: tuple[ChangeDriver, ...] = ()
    primary_change: str | None = None
    rank: int | None = None
    previous_rank: int | None = None
    rank_change: int | None = None
    drivers: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class VerificationSnapshot:
    """Operational state and derived intelligence for one asset at one instant."""

    sgw_id: str
    verification_status: str
    generator_status: str
    operational_status: str
    backup_available_hours: float | None
    restoration_hours: float
    risk_score: float
    risk_tier: RiskTier
    consequence_score: float
    disruption_likelihood: float
    confidence: str
    confidence_score: float
    max_uncovered_hours: float
    rank: int | None


@dataclass(frozen=True)
class VerificationImpact:
    """One before/after movement caused by a recorded field result."""

    sgw_id: str
    metric: str
    previous: Any
    current: Any
    unit: str | None
    direction: str
    summary: str


@dataclass(frozen=True)
class FieldVerification:
    """Immutable record of a field result and the reassessment it triggered."""

    verification_id: str
    advisory_id: str
    verified_asset_id: str
    dependent_asset_ids: tuple[str, ...]
    recommendation_id: str | None
    outcome: FieldOutcome
    detail: str
    verified_by: str
    recorded_at: str
    before: tuple[VerificationSnapshot, ...]
    after: tuple[VerificationSnapshot, ...]
    impacts: tuple[VerificationImpact, ...]
    narrative: str
    applied_to_advisories: tuple[str, ...] = ()
