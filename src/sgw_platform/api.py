from __future__ import annotations

from dataclasses import asdict
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from sgw_platform.adapters.json_adapter import JsonInfrastructureAdapter
from sgw_platform.application import PlatformApplication


load_dotenv(Path(__file__).parents[2] / ".env")


class ExplainRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    asset_id: str | None = None
    advisory: str | None = None


class FieldResultRequest(BaseModel):
    """What a field team observed. The backend derives every consequence."""

    outcome: str = Field(min_length=1)
    detail: str = Field(default="", max_length=500)
    verified_by: str | None = None
    confirmed_backup_hours: float | None = Field(default=None, ge=0, le=720)


class ResponseDecisionRequest(BaseModel):
    action: str
    actor: str = Field(min_length=1)
    owner: str | None = None
    reason: str | None = None
    occurred_at: str | None = None
    result: FieldResultRequest | None = None


class FieldVerificationRequest(BaseModel):
    asset_id: str = Field(min_length=1)
    outcome: str = Field(min_length=1)
    verified_by: str = Field(min_length=1)
    detail: str = Field(default="", max_length=500)
    advisory: str | None = None
    confirmed_backup_hours: float | None = Field(default=None, ge=0, le=720)
    recommendation_id: str | None = None
    occurred_at: str | None = None


class BriefingRequest(BaseModel):
    advisory: str | None = None


class BriefingApprovalRequest(BaseModel):
    approved_by: str = Field(min_length=1)
    final_text: str = Field(min_length=1)
    approved_at: str | None = None


def create_app(platform: PlatformApplication | None = None) -> FastAPI:
    if platform is None:
        default_data_path = Path(__file__).parents[2] / "data" / "synthetic_sgw.json"
        data_path = Path(os.getenv("SGW_DATA_PATH", default_data_path))
        platform = PlatformApplication(JsonInfrastructureAdapter(data_path))

    app = FastAPI(
        title="SGW Resilience Intelligence API",
        version="0.1.0",
        description="Coherent application state derived by the SGW backend.",
    )
    app.state.platform = platform
    allowed_origins = [
        item.strip()
        for item in os.getenv(
            "SGW_CORS_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if item.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/model")
    def model_card():
        """Card for the experimental ML track.

        Published so the estimate can never appear on screen without its
        provenance: what it is, what it was trained on, and the fact that it
        does not drive the operational ranking.
        """
        from sgw_platform.ml.likelihood_model import (
            DISRUPTION_MODEL,
            MODEL_NAME,
            MODEL_VERSION,
            TRAINING_DESCRIPTION,
        )
        from sgw_platform.ml.training_data import FEATURE_ORDER, TRAINING_ROWS, TRAINING_SEED

        coefficients = DISRUPTION_MODEL.coefficients()
        return {
            "name": MODEL_NAME,
            "version": MODEL_VERSION,
            "available": DISRUPTION_MODEL.available,
            "status": "experimental",
            "deployment_mode": "shadow",
            "drives_operational_ranking": False,
            "training_data": TRAINING_DESCRIPTION,
            "training_rows": TRAINING_ROWS,
            "training_seed": TRAINING_SEED,
            "features": FEATURE_ORDER,
            "coefficients": dict(
                sorted(coefficients.items(), key=lambda item: abs(item[1]), reverse=True)
            ),
            "caveat": (
                "Runs in shadow mode. Trained on synthetic history, not on SGW "
                "outcomes, so it is not independent real-world evidence and is not a "
                "validated failure probability. Promotion into the decision path "
                "requires real outcome data to measure calibration against."
            ),
        }

    @app.get("/api/model/divergence")
    def baseline_divergence(t: str | None = Query(default=None)):
        """Assets where the operational and experimental tracks disagree."""
        try:
            return platform.baseline_divergence(t)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/state")
    def current_state(t: str | None = Query(default=None)):
        try:
            return platform.current_state(t)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/assets/{asset_id}")
    def asset_detail(asset_id: str, t: str | None = Query(default=None)):
        try:
            return platform.asset_detail(asset_id, t)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/explain")
    def explain(request: ExplainRequest):
        try:
            return platform.explain(request.question, request.advisory, request.asset_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/responses/{recommendation_id}")
    def decide_response(recommendation_id: str, request: ResponseDecisionRequest):
        try:
            recommendation, verification = platform.decide_response(
                recommendation_id,
                request.action,
                request.actor,
                owner=request.owner,
                reason=request.reason,
                occurred_at=request.occurred_at,
                result=request.result.model_dump() if request.result else None,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown recommendation: {recommendation_id}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {**asdict(recommendation), "verification": asdict(verification) if verification else None}

    @app.get("/api/responses/{recommendation_id}/record")
    def governance_record(recommendation_id: str):
        try:
            return platform.governance_record(recommendation_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown recommendation: {recommendation_id}") from exc

    @app.post("/api/responses/{recommendation_id}/rationale")
    def explain_recommendation(recommendation_id: str):
        try:
            return platform.explain_recommendation(recommendation_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown recommendation: {recommendation_id}") from exc

    @app.get("/api/playbook-rules")
    def playbook_rules():
        return {"rules": platform.playbook_catalogue()}

    @app.post("/api/verifications")
    def record_verification(request: FieldVerificationRequest):
        try:
            return asdict(platform.record_field_verification(
                request.asset_id,
                request.outcome,
                request.verified_by,
                detail=request.detail,
                advisory_value=request.advisory,
                confirmed_backup_hours=request.confirmed_backup_hours,
                recommendation_id=request.recommendation_id,
                occurred_at=request.occurred_at,
            ))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/verifications")
    def list_verifications(t: str | None = Query(default=None)):
        try:
            return {"verifications": [asdict(item) for item in platform.verifications(t)]}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/briefings")
    def create_briefing(request: BriefingRequest):
        try:
            return asdict(platform.create_briefing(request.advisory))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/briefings/{briefing_id}/approve")
    def approve_briefing(briefing_id: str, request: BriefingApprovalRequest):
        try:
            return asdict(platform.approve_briefing(
                briefing_id,
                request.approved_by,
                request.final_text,
                request.approved_at,
            ))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown briefing: {briefing_id}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return app


app = create_app()
