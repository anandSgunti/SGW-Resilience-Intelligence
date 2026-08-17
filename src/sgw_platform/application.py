from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sgw_platform.adapters.base import InfrastructureAdapter
from sgw_platform.assessment import AssessmentEngine
from sgw_platform.explanations import (
    FactPackBuilder,
    Narrator,
    OpenAIResponsesNarrator,
    RecommendationFactPackBuilder,
    TemplateNarrator,
)
from sgw_platform.rules import published_catalogue
from sgw_platform.graph import DependencyGraph
from sgw_platform.models import (
    ActionClass,
    Advisory,
    Assessment,
    AssetState,
    BriefingStatus,
    FieldOutcome,
    FieldVerification,
    LeadershipBriefing,
    Recommendation,
    RecommendationStatus,
    VerificationSnapshot,
)
from sgw_platform.playbooks import PlaybookEngine, RecommendationStore
from sgw_platform.verification import FieldVerificationEngine


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class PlatformApplication:
    """One coherent, reusable state boundary for API, jobs, and future storage."""

    def __init__(self, adapter: InfrastructureAdapter, narrator: Narrator | None = None):
        self.adapter = adapter
        self.assets = adapter.load_assets()
        self.assets_by_id = {asset.sgw_id: asset for asset in self.assets}
        self.source_id_index = {
            source_id: asset.sgw_id
            for asset in self.assets
            for source_id in asset.source_ids.values()
        }
        self.advisories = adapter.load_advisories()
        self.advisories_by_id = {item.advisory_id: item for item in self.advisories}
        self.advisories_by_stage = {item.stage.casefold(): item for item in self.advisories}
        self.states = {
            advisory.advisory_id: adapter.load_states(advisory.advisory_id)
            for advisory in self.advisories
        }
        self.graph = DependencyGraph(adapter.load_dependencies())
        self.timeline = AssessmentEngine().assess_timeline(
            self.assets, self.advisories, self.states, self.graph
        )
        self.playbooks = PlaybookEngine()
        self.recommendations = RecommendationStore()
        self.verification_engine = FieldVerificationEngine()
        self.narrator = narrator or self._default_narrator()
        self._briefings: dict[str, LeadershipBriefing] = {}
        self._verifications: list[FieldVerification] = []

    @staticmethod
    def _default_narrator() -> Narrator:
        return OpenAIResponsesNarrator() if os.getenv("OPENAI_API_KEY") else TemplateNarrator()

    def resolve_advisory(self, value: str | None) -> Advisory:
        if value is None:
            return self.advisories[-1]
        normalized = value.strip()
        advisory = self.advisories_by_id.get(normalized)
        if advisory is None:
            advisory = self.advisories_by_stage.get(normalized.casefold())
        if advisory is None:
            raise KeyError(f"Unknown advisory or stage: {value}")
        return advisory

    def resolve_asset_id(self, value: str) -> str:
        if value in self.assets_by_id:
            return value
        canonical = self.source_id_index.get(value)
        if canonical is None:
            raise KeyError(f"Unknown asset: {value}")
        return canonical

    def assessment(self, asset_id: str, advisory_id: str) -> Assessment:
        return next(
            item for item in self.timeline[advisory_id]
            if item.sgw_id == asset_id
        )

    def _ensure_recommendations(self, advisory: Advisory) -> list[Recommendation]:
        existing = self.recommendations.list()
        existing_ids = {item.recommendation_id for item in existing}
        generated = self.playbooks.evaluate(
            self.timeline[advisory.advisory_id],
            self.assets_by_id,
            advisory,
            existing,
        )
        for item in generated:
            if item.recommendation_id not in existing_ids:
                self.recommendations.add(item)
                existing_ids.add(item.recommendation_id)
        return sorted(
            (
                item for item in self.recommendations.list()
                if item.advisory_id == advisory.advisory_id
            ),
            key=lambda item: (item.asset_id, item.rule_id, item.recommendation_id),
        )

    # ------------------------------------------------------------------
    # Field verification -> reassessment loop
    # ------------------------------------------------------------------

    def _snapshot_all(self, advisory_id: str) -> tuple[VerificationSnapshot, ...]:
        """Capture operational state plus derived intelligence for every asset."""
        states_by_id = {item.sgw_id: item for item in self.states[advisory_id]}
        return tuple(
            self.verification_engine.snapshot(states_by_id[item.sgw_id], item)
            for item in self.timeline[advisory_id]
            if item.sgw_id in states_by_id
        )

    def _forward_advisories(self, advisory: Advisory) -> list[Advisory]:
        """A confirmed field observation also holds for every later advisory."""
        index = self.advisories.index(advisory)
        return self.advisories[index:]

    def _reassess(self) -> None:
        self.timeline = AssessmentEngine().assess_timeline(
            self.assets, self.advisories, self.states, self.graph
        )

    def record_field_verification(
        self,
        asset_value: str,
        outcome: str,
        verified_by: str,
        *,
        detail: str = "",
        advisory_value: str | None = None,
        confirmed_backup_hours: float | None = None,
        recommendation_id: str | None = None,
        occurred_at: str | None = None,
    ) -> FieldVerification:
        """Record a field result, update operational state, and reassess.

        The engines are untouched: this only rewrites the observed `AssetState`
        the existing likelihood, consequence and confidence layers already read.
        """
        if not verified_by.strip():
            raise ValueError("A verifying field operator is required")
        try:
            field_outcome = FieldOutcome(outcome)
        except ValueError as exc:
            raise ValueError(f"Unknown field verification outcome: {outcome}") from exc

        asset_id = self.resolve_asset_id(asset_value)
        advisory = self.resolve_advisory(advisory_value)
        recorded_at = occurred_at or _utc_now()

        before = self._snapshot_all(advisory.advisory_id)
        before_by_id = {item.sgw_id: item for item in before}
        if asset_id not in before_by_id:
            raise KeyError(f"No operational state to verify for {asset_id}")

        applied: list[str] = []
        for forward in self._forward_advisories(advisory):
            updated: list[AssetState] = []
            for state in self.states[forward.advisory_id]:
                if state.sgw_id != asset_id:
                    updated.append(state)
                    continue
                updated.append(self.verification_engine.apply(
                    state, field_outcome, confirmed_backup_hours, recorded_at, verified_by.strip(),
                ))
            self.states[forward.advisory_id] = updated
            applied.append(forward.advisory_id)

        self._reassess()
        self._ensure_recommendations(advisory)

        after = self._snapshot_all(advisory.advisory_id)
        after_by_id = {item.sgw_id: item for item in after}
        impacts = self.verification_engine.impacts(before, after)
        moved_ids = {impact.sgw_id for impact in impacts} | {asset_id}
        # Only assets with a real topological relationship are "dependents". An
        # asset can move purely because the ranking was recomputed around it;
        # recording that as a dependency would be a false causal claim.
        related = self.graph.related(asset_id)
        dependent_ids = tuple(sorted((moved_ids & related) - {asset_id}))
        reranked_ids = tuple(sorted(moved_ids - related - {asset_id}))
        narrative = self.verification_engine.narrative(
            advisory.stage, recorded_at, verified_by.strip(), field_outcome, detail,
            before_by_id[asset_id], after_by_id[asset_id],
        )
        record = FieldVerification(
            verification_id=f"VER-{advisory.advisory_id}-{asset_id}-{len(self._verifications) + 1:03d}",
            advisory_id=advisory.advisory_id,
            verified_asset_id=asset_id,
            dependent_asset_ids=dependent_ids,
            reranked_asset_ids=reranked_ids,
            recommendation_id=recommendation_id,
            outcome=field_outcome,
            detail=detail.strip(),
            verified_by=verified_by.strip(),
            recorded_at=recorded_at,
            before=tuple(before_by_id[item] for item in sorted(moved_ids) if item in before_by_id),
            after=tuple(after_by_id[item] for item in sorted(moved_ids) if item in after_by_id),
            impacts=impacts,
            narrative=narrative,
            applied_to_advisories=tuple(applied),
        )
        self._verifications.append(record)
        return record

    def verifications(self, advisory_value: str | None = None) -> list[FieldVerification]:
        """Verification history for one advisory, oldest first."""
        advisory = self.resolve_advisory(advisory_value)
        return [item for item in self._verifications if item.advisory_id == advisory.advisory_id]

    def asset_verifications(self, asset_id: str) -> list[FieldVerification]:
        """Every verification that moved this asset, across advisories."""
        return [
            item for item in self._verifications
            if item.verified_asset_id == asset_id or asset_id in item.dependent_asset_ids
        ]

    def current_state(self, advisory_value: str | None = None) -> dict[str, Any]:
        advisory = self.resolve_advisory(advisory_value)
        assessments = self.timeline[advisory.advisory_id]
        states_by_id = {item.sgw_id: item for item in self.states[advisory.advisory_id]}
        map_assets = [
            {
                "sgw_id": asset.sgw_id,
                "name": asset.name,
                "asset_type": asset.asset_type.value,
                "latitude": asset.latitude,
                "longitude": asset.longitude,
                "operating_zone": asset.attributes.get("operating_zone", "lower_exposure"),
                "hazard": asdict(states_by_id[asset.sgw_id]),
            }
            for asset in self.assets
        ]
        exposed_zone_ids: set[str] = set()
        for assessment in assessments:
            if assessment.tier.value not in {"critical", "high"}:
                continue
            candidate_ids = {assessment.sgw_id, *self.graph.descendants(assessment.sgw_id)}
            exposed_zone_ids.update(
                asset_id for asset_id in candidate_ids
                if self.assets_by_id[asset_id].asset_type.value == "water_zone"
            )
        exposed_residents = sum(
            int(self.assets_by_id[zone_id].attributes.get("population", 0))
            for zone_id in exposed_zone_ids
        )
        responses = self._ensure_recommendations(advisory)
        return {
            "advisory": asdict(advisory),
            "summary": {
                "critical_assets": sum(item.tier.value == "critical" for item in assessments),
                "high_assets": sum(item.tier.value == "high" for item in assessments),
                "exposed_residents": exposed_residents,
                "open_actions": sum(item.status.value not in {"completed", "rejected"} for item in responses),
                "data_freshness_minutes": dict(advisory.data_freshness_minutes),
            },
            "assessments": [asdict(item) for item in assessments],
            "map": {
                "assets": map_assets,
                "hurricane": {
                    "event_id": advisory.event_id,
                    "center": {
                        "latitude": advisory.storm_center_latitude,
                        "longitude": advisory.storm_center_longitude,
                    },
                    "impact_radius_km": advisory.impact_radius_km,
                    "track": list(advisory.storm_track),
                },
                "operating_zones": [
                    {"id": "coastal", "name": "Coastal Operations Zone", "coordinates": [[32.68, -80.02], [32.68, -79.80], [32.88, -79.80], [32.88, -80.02]]},
                    {"id": "inland_flood", "name": "Inland Flood Zone", "coordinates": [[32.96, -80.20], [32.96, -80.02], [33.20, -80.02], [33.20, -80.20]]},
                    {"id": "inland_resilient", "name": "Inland Resilient Zone", "coordinates": [[32.88, -80.44], [32.88, -80.22], [33.14, -80.22], [33.14, -80.44]]},
                ],
                "hazard_areas": [
                    {"id": "coastal_flood", "name": "Coastal flood exposure", "hazard": "flood", "coordinates": [[32.69, -79.99], [32.69, -79.79], [32.86, -79.79], [32.86, -79.99]]},
                    {"id": "inland_flood", "name": "Inland rainfall flooding", "hazard": "flood", "coordinates": [[32.99, -80.18], [32.99, -80.03], [33.18, -80.03], [33.18, -80.18]]},
                ],
            },
            "responses": [asdict(item) for item in responses],
            "verifications": [asdict(item) for item in self.verifications(advisory.advisory_id)],
        }

    def asset_detail(self, asset_value: str, advisory_value: str | None = None) -> dict[str, Any]:
        asset_id = self.resolve_asset_id(asset_value)
        advisory = self.resolve_advisory(advisory_value)
        asset = self.assets_by_id[asset_id]
        assessment = self.assessment(asset_id, advisory.advisory_id)
        state = next(item for item in self.states[advisory.advisory_id] if item.sgw_id == asset_id)
        descendants = self.graph.descendants(asset_id)
        node_ids = {asset_id, *descendants}
        edges = [
            edge for edge in self.graph.dependencies
            if (edge.from_id in node_ids and edge.to_id in node_ids)
            or edge.to_id == asset_id
            or (edge.to_id in node_ids and edge.relationship.value == "backup_feed")
        ]
        node_ids.update(edge.from_id for edge in edges)
        states_by_id = {item.sgw_id: item for item in self.states[advisory.advisory_id]}
        return {
            "advisory": asdict(advisory),
            "asset": asdict(asset),
            "state": asdict(state),
            "assessment": asdict(assessment),
            "dependency_subgraph": {
                "nodes": [asdict(self.assets_by_id[item_id]) for item_id in sorted(node_ids)],
                "edges": [asdict(edge) for edge in edges],
            },
            "node_context": {
                item_id: {
                    "asset": asdict(self.assets_by_id[item_id]),
                    "state": asdict(states_by_id[item_id]),
                    "assessment": asdict(self.assessment(item_id, advisory.advisory_id)),
                }
                for item_id in sorted(node_ids)
            },
            "consequence_drivers": [asdict(item) for item in assessment.current_drivers],
            "confidence_reasons": list(assessment.confidence_reasons),
            "change_drivers": [asdict(item) for item in assessment.change_drivers],
            "recommended_actions": [
                asdict(item) for item in self._ensure_recommendations(advisory)
                if item.asset_id == asset_id
            ],
            "verification_history": [asdict(item) for item in self.asset_verifications(asset_id)],
        }

    def explain(
        self,
        question: str,
        advisory_value: str | None = None,
        asset_value: str | None = None,
    ) -> dict[str, Any]:
        advisory = self.resolve_advisory(advisory_value)
        if asset_value:
            asset_id = self.resolve_asset_id(asset_value)
            asset = self.assets_by_id[asset_id]
            assessment = self.assessment(asset_id, advisory.advisory_id)
            fact_pack = FactPackBuilder.build(asset, advisory, assessment)
            fact_pack["question"] = question
            fact_pack["ranked_comparison"] = [
                {
                    "sgw_id": item.sgw_id,
                    "rank": item.rank,
                    "risk_score": item.risk_score,
                    "risk_tier": item.tier.value,
                    "likelihood_percent": item.disruption_likelihood,
                    "consequence_score": item.consequence_score,
                    "effective_population": item.affected_population,
                    "uncovered_hours": item.max_uncovered_hours,
                }
                for item in self.timeline[advisory.advisory_id]
                if item.sgw_id != asset_id
            ]
            answer = self.narrator.generate(fact_pack)
            headline = f"{asset.name}: {assessment.tier.value.title()} risk"
            supporting = [asdict(item) for item in assessment.current_drivers[:3]]
            follow_ups = [
                f"What changed for {asset.name}?",
                f"Which services depend on {asset.name}?",
                "What evidence should be verified?",
            ]
        else:
            assessments = self.timeline[advisory.advisory_id]
            fact_pack = {
                "question": question,
                "advisory": asdict(advisory),
                "top_assessments": [
                    {
                        "sgw_id": item.sgw_id,
                        "risk_score": item.risk_score,
                        "tier": item.tier.value,
                        "rank": item.rank,
                        "uncovered_hours": item.max_uncovered_hours,
                        "affected_population": item.affected_population,
                    }
                    for item in assessments[:8]
                ],
                "provenance": "Deterministic SGW assessments; answer only from these facts.",
            }
            if isinstance(self.narrator, TemplateNarrator):
                top = assessments[0]
                answer = (
                    f"{top.sgw_id} is the highest-ranked asset at {advisory.stage}, "
                    f"with {top.tier.value} risk and a score of {top.risk_score}."
                )
            else:
                answer = self.narrator.generate(fact_pack)
            headline = f"SGW situation at {advisory.stage}"
            supporting = fact_pack["top_assessments"][:3]
            follow_ups = [
                "Which assets have insufficient backup?",
                "What changed since the previous advisory?",
                "Which critical facilities are exposed?",
            ]
        return {
            "headline": headline,
            "answer": answer,
            "supporting_facts": supporting,
            "suggested_follow_up_questions": follow_ups,
            "fact_pack_sha256": _digest(fact_pack),
            "model": self.narrator.model,
            "grounded": True,
        }

    def decide_response(
        self,
        recommendation_id: str,
        action: str,
        actor: str,
        *,
        owner: str | None = None,
        reason: str | None = None,
        occurred_at: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> tuple[Recommendation, FieldVerification | None]:
        """Record one attributed human decision, plus any field result it carries.

        Returns the updated recommendation and, when a field-verification action
        was completed with a recorded result, the reassessment it triggered.
        """
        action_map = {
            "approve": RecommendationStatus.APPROVED,
            "reject": RecommendationStatus.REJECTED,
            "assign": RecommendationStatus.ASSIGNED,
            "start": RecommendationStatus.IN_PROGRESS,
            "complete": RecommendationStatus.COMPLETED,
        }
        if action not in action_map:
            raise ValueError(f"Unknown response action: {action}")
        pending = self.recommendations.get(recommendation_id)
        if result and pending.action_class is not ActionClass.FIELD_VERIFICATION:
            raise ValueError("A field result can only be recorded against a verification action")
        if result and action != "complete":
            raise ValueError("A field result can only be recorded when completing the action")
        updated = self.recommendations.transition(
            recommendation_id,
            action_map[action],
            actor,
            owner=owner,
            reason=reason,
            occurred_at=occurred_at,
        )
        if not result:
            return updated, None
        verification = self.record_field_verification(
            updated.target_asset_id or updated.asset_id,
            result["outcome"],
            result.get("verified_by") or updated.owner or actor,
            detail=result.get("detail", "") or (reason or ""),
            advisory_value=updated.advisory_id,
            confirmed_backup_hours=result.get("confirmed_backup_hours"),
            recommendation_id=recommendation_id,
            occurred_at=occurred_at,
        )
        return updated, verification

    # ------------------------------------------------------------------
    # Recommendation evidence and playbook transparency
    # ------------------------------------------------------------------

    def governance_record(self, recommendation_id: str) -> dict[str, Any]:
        """Everything an auditor needs about one recommendation, in one object.

        Answers: what was recommended, why, which rule and version fired, which
        advisory and state it was derived from, and who decided what.
        """
        recommendation = self.recommendations.get(recommendation_id)
        verification = next(
            (item for item in self._verifications if item.recommendation_id == recommendation_id),
            None,
        )
        return {
            "recommendation": asdict(recommendation),
            "what": recommendation.title,
            "why": {
                "rationale": recommendation.reason,
                "trigger": [asdict(item) for item in recommendation.evidence.trigger] if recommendation.evidence else [],
                "impact": recommendation.evidence.impact_summary if recommendation.evidence else "",
            },
            "rule": asdict(recommendation.rule) if recommendation.rule else None,
            "rule_version": recommendation.rule_version,
            "assessment_source": recommendation.evidence.assessment_source if recommendation.evidence else None,
            "advisory_id": recommendation.advisory_id,
            "decisions": [asdict(item) for item in recommendation.history],
            "field_verification": asdict(verification) if verification else None,
        }

    def explain_recommendation(self, recommendation_id: str) -> dict[str, Any]:
        """Ask the narrator to restate one rationale in plain language.

        The narrator receives a read-only fact pack and returns a display string.
        Nothing here writes to the recommendation store, and the stored record is
        compared before and after so a narrator can never alter an action.
        """
        recommendation = self.recommendations.get(recommendation_id)
        fact_pack = RecommendationFactPackBuilder.build(recommendation)
        fingerprint = _digest(asdict(recommendation))
        rationale = self.narrator.generate(fact_pack)
        unchanged = self.recommendations.get(recommendation_id)
        if _digest(asdict(unchanged)) != fingerprint:
            raise RuntimeError("Narration must never modify a playbook action")
        return {
            "recommendation_id": recommendation_id,
            "rationale": rationale,
            "authored_rationale": recommendation.reason,
            "rule_id": recommendation.rule_id,
            "rule_version": recommendation.rule_version,
            "assessment_source": recommendation.evidence.assessment_source if recommendation.evidence else None,
            "status": unchanged.status.value,
            "fact_pack_sha256": _digest(fact_pack),
            "model": self.narrator.model,
            "grounded": True,
            "advisory_note": (
                "Narration is display-only. The playbook action, its rule and its "
                "lifecycle are unchanged by this text."
            ),
        }

    @staticmethod
    def playbook_catalogue() -> list[dict[str, Any]]:
        """Every published rule, including those that did not fire."""
        return [asdict(item) for item in published_catalogue()]

    def create_briefing(self, advisory_value: str | None = None) -> LeadershipBriefing:
        advisory = self.resolve_advisory(advisory_value)
        assessments = self.timeline[advisory.advisory_id]
        recommendations = self._ensure_recommendations(advisory)
        tier_counts = {
            tier: sum(item.tier.value == tier for item in assessments)
            for tier in ("critical", "high", "medium", "low")
        }
        fact_pack = {
            "advisory": asdict(advisory),
            "tier_counts": tier_counts,
            "top_risks": [
                {
                    "sgw_id": item.sgw_id,
                    "risk_score": item.risk_score,
                    "tier": item.tier.value,
                    "rank": item.rank,
                    "primary_change": item.primary_change,
                }
                for item in assessments[:5]
            ],
            "response_statuses": {
                status.value: sum(item.status is status for item in recommendations)
                for status in RecommendationStatus
            },
            "provenance": "Deterministic SGW platform state; summarize only supplied facts.",
        }
        if isinstance(self.narrator, TemplateNarrator):
            top = assessments[0]
            text = (
                f"At {advisory.stage}, SGW has {tier_counts['critical']} Critical and "
                f"{tier_counts['high']} High risk assets. {top.sgw_id} is ranked first "
                f"with a systemic risk score of {top.risk_score}. "
                f"{len(recommendations)} response actions require human review."
            )
        else:
            text = self.narrator.generate(fact_pack)
        version = 1 + sum(
            item.advisory_id == advisory.advisory_id for item in self._briefings.values()
        )
        briefing = LeadershipBriefing(
            briefing_id=f"BRF-{advisory.advisory_id}-{version:03d}",
            advisory_id=advisory.advisory_id,
            version=version,
            text=text,
            fact_pack_sha256=_digest(fact_pack),
            model=self.narrator.model,
            created_at=_utc_now(),
        )
        self._briefings[briefing.briefing_id] = briefing
        return briefing

    def approve_briefing(
        self,
        briefing_id: str,
        approved_by: str,
        final_text: str,
        approved_at: str | None = None,
    ) -> LeadershipBriefing:
        if not approved_by.strip():
            raise ValueError("An approving human is required")
        if not final_text.strip():
            raise ValueError("Final briefing text is required")
        briefing = self._briefings[briefing_id]
        if briefing.status is BriefingStatus.APPROVED:
            raise ValueError("Briefing is already approved")
        approved = replace(
            briefing,
            status=BriefingStatus.APPROVED,
            approved_by=approved_by,
            approved_at=approved_at or _utc_now(),
            final_text=final_text,
        )
        self._briefings[briefing_id] = approved
        return approved
