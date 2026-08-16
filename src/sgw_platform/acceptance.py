from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.adapters.source_adapters import SourceRecordIndex
from sgw_platform.api import create_app
from sgw_platform.application import PlatformApplication
from sgw_platform.explanations import TemplateNarrator
from sgw_platform.models import ActionClass, RecommendationStatus, RiskTier
from sgw_platform.playbooks import PlaybookEngine, RecommendationStore
from sgw_platform.synthetic import build_synthetic_payload


@dataclass(frozen=True)
class AcceptanceCheck:
    check_id: str
    label: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class AcceptanceReport:
    checks: tuple[AcceptanceCheck, ...]

    @property
    def passed(self) -> bool:
        return all(check.passed for check in self.checks)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "checks": [asdict(check) for check in self.checks],
        }


class MilestoneVerifier:
    """Executable Step 5J gate for the backend milestone."""

    REQUIRED_ROUTES = {
        ("GET", "/health"),
        ("GET", "/api/state"),
        ("GET", "/api/assets/{asset_id}"),
        ("POST", "/api/explain"),
        ("POST", "/api/responses/{recommendation_id}"),
        ("GET", "/api/responses/{recommendation_id}/record"),
        ("POST", "/api/responses/{recommendation_id}/rationale"),
        ("GET", "/api/playbook-rules"),
        ("POST", "/api/verifications"),
        ("GET", "/api/verifications"),
        ("POST", "/api/briefings"),
        ("POST", "/api/briefings/{briefing_id}/approve"),
    }

    def __init__(self, data_path: str | Path):
        self.adapter = JsonInfrastructureAdapter(data_path)
        self.platform = PlatformApplication(self.adapter, narrator=TemplateNarrator())

    @staticmethod
    def _check(check_id: str, label: str, condition: bool, detail: str) -> AcceptanceCheck:
        return AcceptanceCheck(check_id, label, bool(condition), detail)

    def verify(self) -> AcceptanceReport:
        checks: list[AcceptanceCheck] = []
        payload = self.adapter.payload
        generated = build_synthetic_payload(42)
        checks.append(self._check(
            "data_determinism",
            "Seed-42 dataset is reproducible",
            payload == generated,
            f"seed={payload.get('metadata', {}).get('seed')}; canonical fixture matches regenerated payload",
        ))

        checks.append(self._check(
            "world_shape",
            "Synthetic network has the locked coherent scale",
            len(self.platform.assets) == 40
            and 30 <= len(self.platform.graph.dependencies) <= 40
            and len(self.platform.advisories) == 5,
            f"assets={len(self.platform.assets)}, dependencies={len(self.platform.graph.dependencies)}, advisories={len(self.platform.advisories)}",
        ))

        source_index = SourceRecordIndex(payload["source_data"])
        identity_ok = (
            source_index.resolve("gis", "GIS/S17") == "SGW-S17"
            and source_index.resolve("field_ops", "OPS-S17") == "SGW-S17"
        )
        checks.append(self._check(
            "identity_federation",
            "Fragmented source identifiers resolve to one SGW identity",
            identity_ok,
            "GIS/S17 and OPS-S17 -> SGW-S17",
        ))

        descendants = self.platform.graph.descendants("SGW-S17")
        required_chain = {"SGW-P4", "SGW-W12", "SGW-H3", "SGW-F2"}
        checks.append(self._check(
            "golden_dependency_chain",
            "S17 dependency chain reaches water service and critical facilities",
            required_chain.issubset(descendants),
            "SGW-S17 -> SGW-P4 -> SGW-W12 -> SGW-H3/SGW-F2",
        ))

        redundancy_ok = (
            self.platform.graph.has_full_alternate_power("SGW-P7", "SGW-S08")
            and self.platform.graph.has_alternate_power("SGW-P9", "SGW-S31")
        )
        checks.append(self._check(
            "redundancy",
            "Full and partial alternate-feed patterns are recognized",
            redundancy_ok,
            "P7 has full alternate supply; P9 has limited alternate supply",
        ))

        t48 = self.platform.assessment("SGW-S17", "ADV-T48")
        t24 = self.platform.assessment("SGW-S17", "ADV-T24")
        t48_state = next(item for item in self.platform.states["ADV-T48"] if item.sgw_id == "SGW-S17")
        t24_state = next(item for item in self.platform.states["ADV-T24"] if item.sgw_id == "SGW-S17")
        transition_ok = (
            t48_state.restoration_hours == 4
            and t24_state.restoration_hours == 14
            and t24.limiting_backup_hours == 6
            and t48.max_uncovered_hours == 0
            and t24.max_uncovered_hours == 8
            and t48.tier is RiskTier.HIGH
            and t24.tier is RiskTier.CRITICAL
            and t48.rank == 5
            and t24.rank == 1
        )
        checks.append(self._check(
            "s17_t48_t24_transition",
            "S17 moves High to Critical because restoration exceeds backup",
            transition_ok,
            f"restoration 4h->14h; backup=6h; gap 0h->8h; rank #{t48.rank}->#{t24.rank}",
        ))

        s31 = self.platform.assessment("SGW-S31", "ADV-T24")
        comparison_ok = (
            s31.disruption_likelihood > t24.disruption_likelihood
            and s31.consequence_score < t24.consequence_score
            and s31.tier is RiskTier.HIGH
        )
        checks.append(self._check(
            "s17_s31_comparison",
            "Higher likelihood does not override lower systemic consequence",
            comparison_ok,
            f"S31 likelihood={s31.disruption_likelihood}, consequence={s31.consequence_score}; S17 likelihood={t24.disruption_likelihood}, consequence={t24.consequence_score}",
        ))

        t24_advisory = self.platform.resolve_advisory("T-24")
        t12_advisory = self.platform.resolve_advisory("T-12")
        t24_actions = PlaybookEngine().evaluate(
            self.platform.timeline["ADV-T24"], self.platform.assets_by_id, t24_advisory
        )
        t12_actions = PlaybookEngine().evaluate(
            self.platform.timeline["ADV-T12"], self.platform.assets_by_id, t12_advisory
        )
        s17_rules = {item.rule_id for item in t24_actions if item.asset_id == "SGW-S17"}
        flood_rule = any(
            item.rule_id == "R4" and item.asset_id == "SGW-P11"
            for item in t12_actions
        )
        checks.append(self._check(
            "playbooks",
            "Deterministic playbooks cover S17 and direct P11 flood exposure",
            s17_rules == {"R1", "R2", "R3", "R5"} and flood_rule,
            f"S17 rules={','.join(sorted(s17_rules))}; P11 R4={flood_rule}",
        ))

        response = next((
            item for item in t24_actions
            if item.asset_id == "SGW-S17" and item.rule_id == "R1"
        ), None)
        completed = None
        if response is not None:
            store = RecommendationStore()
            store.add(response)
            store.transition(response.recommendation_id, RecommendationStatus.APPROVED, "Acceptance Controller")
            store.transition(
                response.recommendation_id,
                RecommendationStatus.ASSIGNED,
                "Acceptance Controller",
                owner=response.default_owner,
            )
            store.transition(response.recommendation_id, RecommendationStatus.IN_PROGRESS, "Acceptance Operator")
            completed = store.transition(
                response.recommendation_id,
                RecommendationStatus.COMPLETED,
                "Acceptance Operator",
                reason="Acceptance workflow completed.",
            )
        audit_ok = (
            completed is not None
            and completed.status is RecommendationStatus.COMPLETED
            and completed.owner == "Field Operations"
            and len(completed.history) == 4
        )
        audit_detail = (
            f"status={completed.status.value}; owner={completed.owner}; events={len(completed.history)}"
            if completed is not None
            else "R1 was not generated, so the human response lifecycle could not start"
        )
        checks.append(self._check(
            "human_audit",
            "Human decisions retain owner, actor and immutable event history",
            audit_ok,
            audit_detail,
        ))

        api = create_app(self.platform)
        schema = api.openapi()
        actual_routes = {
            (method.upper(), path)
            for path, operations in schema["paths"].items()
            for method in operations
            if method in {"get", "post", "put", "patch", "delete"}
        }
        checks.append(self._check(
            "api_contract",
            "All locked backend routes are exposed",
            self.REQUIRED_ROUTES.issubset(actual_routes),
            f"required={len(self.REQUIRED_ROUTES)}; exposed={len(actual_routes)}",
        ))

        transparency_actions = PlaybookEngine().evaluate(
            self.platform.timeline["ADV-T24"], self.platform.assets_by_id, t24_advisory
        )
        code_markers = ("assessment.", "lambda", "==", "self.", "RiskTier.")
        transparency_ok = bool(transparency_actions) and all(
            item.rule is not None
            and item.rule.version
            and item.evidence is not None
            and item.evidence.trigger
            and item.evidence.impact_summary
            and item.evidence.assessment_source == "IRIS-T24"
            and not any(
                marker in condition.summary
                for condition in item.evidence.trigger
                for marker in code_markers
            )
            for item in transparency_actions
        )
        sample = next((item for item in transparency_actions if item.rule_id == "R1"), None)
        checks.append(self._check(
            "playbook_transparency",
            "Every recommendation publishes rule, version, trigger and impact",
            transparency_ok,
            f"{sample.rule.rule_id} v{sample.rule.version} | {sample.evidence.trigger[0].summary} | "
            f"{sample.evidence.impact_summary} | {sample.evidence.assessment_source}"
            if sample else "No R1 recommendation was generated",
        ))

        governance_platform = PlatformApplication(self.adapter, narrator=TemplateNarrator())
        governance_platform._ensure_recommendations(governance_platform.resolve_advisory("T-24"))
        governed = next(
            (item for item in governance_platform.recommendations.list() if item.rule_id == "R1"),
            None,
        )
        governance_ok, governance_detail = False, "No R1 recommendation was generated to audit"
        if governed is not None:
            governance_platform.decide_response(governed.recommendation_id, "approve", "Jett Rowe")
            before_narration = governance_platform.recommendations.get(governed.recommendation_id)
            narrated = governance_platform.explain_recommendation(governed.recommendation_id)
            after_narration = governance_platform.recommendations.get(governed.recommendation_id)
            record = governance_platform.governance_record(governed.recommendation_id)
            governance_ok = (
                record["what"] == governed.title
                and record["rule_version"] == "1.2"
                and record["assessment_source"] == "IRIS-T24"
                and record["advisory_id"] == "ADV-T24"
                and [item["actor"] for item in record["decisions"]] == ["Jett Rowe"]
                and bool(record["why"]["trigger"])
                and before_narration == after_narration
                and narrated["status"] == "approved"
            )
            governance_detail = (
                f"rule {record['rule_version']} | source {record['assessment_source']} | "
                f"decided by {', '.join(item['actor'] for item in record['decisions']) or 'nobody'} | "
                f"narration left the action unchanged: {before_narration == after_narration}"
            )
        checks.append(self._check(
            "recommendation_governance_record",
            "Audit record answers what, why, which rule/version, which advisory and who",
            governance_ok,
            governance_detail,
        ))

        loop_platform = PlatformApplication(self.adapter, narrator=TemplateNarrator())
        loop_advisory = loop_platform.resolve_advisory("T-24")
        verification_action = next((
            item for item in loop_platform._ensure_recommendations(loop_advisory)
            if item.action_class is ActionClass.FIELD_VERIFICATION
        ), None)
        loop_ok, loop_detail = False, "No field-verification action was recommended"
        if verification_action is not None:
            target = verification_action.target_asset_id or verification_action.asset_id
            source = verification_action.asset_id
            before = loop_platform.assessment(source, loop_advisory.advisory_id)
            for step, actor, owner in (
                ("approve", "Acceptance Controller", None),
                ("assign", "Acceptance Controller", verification_action.default_owner),
                ("start", "Acceptance Operator", None),
            ):
                loop_platform.decide_response(
                    verification_action.recommendation_id, step, actor, owner=owner
                )
            _, verification = loop_platform.decide_response(
                verification_action.recommendation_id,
                "complete",
                "Acceptance Operator",
                reason="Acceptance verification completed.",
                result={"outcome": "verified_operational", "detail": "Readiness confirmed on site."},
            )
            after = loop_platform.assessment(source, loop_advisory.advisory_id)
            loop_ok = (
                verification is not None
                and verification.verified_asset_id == target
                and after.confidence_score > before.confidence_score
                and after.risk_score == before.risk_score
                and bool(verification.narrative)
                and any(item.metric == "verification_status" for item in verification.impacts)
            )
            loop_detail = (
                f"{target} verified; {source} confidence {before.confidence}"
                f"->{after.confidence}; risk held at {after.risk_score}"
            )
        checks.append(self._check(
            "verification_reassessment_loop",
            "Recorded field results update state and trigger reassessment",
            loop_ok,
            loop_detail,
        ))

        explanation = self.platform.explain(
            "Why is S17 Critical?", "T-24", "SGW-S17"
        )
        checks.append(self._check(
            "llm_down_mode",
            "Grounded explanations remain available without an OpenAI connection",
            explanation["grounded"] is True
            and explanation["model"] == "deterministic-template"
            and len(explanation["fact_pack_sha256"]) == 64,
            f"model={explanation['model']}; grounded={explanation['grounded']}",
        ))

        return AcceptanceReport(tuple(checks))
