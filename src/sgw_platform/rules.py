"""Published playbook rule catalogue.

This is the only place a rule's identity, version and operator-language summary
live. It deliberately publishes *what* a rule watches and *which limits* are
configured, never the predicate that implements it. Bump `version` whenever the
matching branch in `PlaybookEngine` changes behaviour: the version travels into
every recommendation and therefore into the audit record.
"""
from __future__ import annotations

from sgw_platform.models import ActionClass, PlaybookRule, RuleThreshold


CRITICAL_BACKUP_GAP_HOURS = 4.0
DIRECT_FLOOD_DEPTH_M = 0.9


CATALOGUE: dict[str, PlaybookRule] = {
    "R1": PlaybookRule(
        rule_id="R1",
        version="1.2",
        name="Critical backup-gap response",
        summary=(
            "Triggered when a Critical asset creates a downstream backup gap above "
            "the configured threshold."
        ),
        action_class=ActionClass.MITIGATION,
        default_owner="Field Operations",
        thresholds=(
            RuleThreshold("Risk tier", "Critical"),
            RuleThreshold("Minimum uncovered gap", f"{CRITICAL_BACKUP_GAP_HOURS:g} hours"),
            RuleThreshold("Requires", "an identified limiting downstream service"),
        ),
    ),
    "R2": PlaybookRule(
        rule_id="R2",
        version="1.1",
        name="Material evidence verification",
        summary=(
            "Triggered when a High or Critical assessment depends on readiness that "
            "has not been verified in the field."
        ),
        action_class=ActionClass.FIELD_VERIFICATION,
        default_owner="Field Operations",
        thresholds=(
            RuleThreshold("Risk tier", "High or Critical"),
            RuleThreshold("Requires", "at least one unverified material asset"),
        ),
    ),
    "R3": PlaybookRule(
        rule_id="R3",
        version="1.0",
        name="Critical facility exposure escalation",
        summary=(
            "Triggered when a Critical assessment exposes one or more downstream "
            "critical facilities."
        ),
        action_class=ActionClass.ESCALATION,
        default_owner="Network Operations",
        thresholds=(
            RuleThreshold("Risk tier", "Critical"),
            RuleThreshold("Minimum critical facilities", "1"),
        ),
    ),
    "R4": PlaybookRule(
        rule_id="R4",
        version="1.1",
        name="Direct flood protection",
        summary=(
            "Triggered when a flood-sensitive asset is directly exposed to water "
            "above the configured depth."
        ),
        action_class=ActionClass.PROTECTION,
        default_owner="Water Operations",
        thresholds=(
            RuleThreshold("Applies to", "flood-sensitive assets only"),
            RuleThreshold("Minimum flood depth", f"{DIRECT_FLOOD_DEPTH_M:g} m"),
        ),
    ),
    "R5": PlaybookRule(
        rule_id="R5",
        version="1.0",
        name="Unmitigated Critical escalation",
        summary=(
            "Triggered when a Critical assessment has no approved or active "
            "mitigation assigned to it."
        ),
        action_class=ActionClass.ESCALATION,
        default_owner="Response Coordinator",
        thresholds=(
            RuleThreshold("Risk tier", "Critical"),
            RuleThreshold("Requires", "no approved, assigned, in-progress or completed mitigation"),
        ),
    ),
}


def rule(rule_id: str) -> PlaybookRule:
    return CATALOGUE[rule_id]


def published_catalogue() -> list[PlaybookRule]:
    return [CATALOGUE[key] for key in sorted(CATALOGUE)]


def assessment_source(event_id: str, stage: str) -> str:
    """Compact traceability token, e.g. HURRICANE-IRIS + T-24 -> IRIS-T24."""
    event = event_id.rsplit("-", 1)[-1] if event_id else "EVENT"
    return f"{event}-{stage.replace('-', '', 1) if stage.startswith('T-') else stage}"
