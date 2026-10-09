import json
from typing import Any, List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.actions import VerificationAction
from app.db import get_session
from app.models import (
    FeedItemResponse,
    ProductCode,
    ProductCodeCreate,
    ScanRequest,
    ScanResponse,
    ScanTelemetryRecord,
)

router = APIRouter(prefix="/api/v1", tags=["sensoo"])
verification_action = VerificationAction()


@router.post("/scan", response_model=ScanResponse)
def scan_product(
    scan_data: ScanRequest,
    session: Session = Depends(get_session),
) -> Any:
    return verification_action.verify_and_record_scan(session, scan_data)


@router.post("/register", response_model=ProductCode)
def register_product(
    product_in: ProductCodeCreate,
    session: Session = Depends(get_session),
) -> Any:
    existing = session.exec(
        select(ProductCode).where(ProductCode.code == product_in.code)
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Product code '{product_in.code}' already exists.",
        )
    product = verification_action.create(session, data=product_in)
    return product


@router.get("/feed", response_model=List[FeedItemResponse])
def get_feed(
    limit: int = 50,
    session: Session = Depends(get_session),
) -> Any:
    stmt = (
        select(ScanTelemetryRecord)
        .order_by(ScanTelemetryRecord.timestamp.desc(), ScanTelemetryRecord.id.desc())
        .limit(limit)
    )
    records = session.exec(stmt).all()

    feed_items = []
    for r in records:
        try:
            alarms_list = json.loads(r.alarms) if r.alarms else []
        except Exception:
            alarms_list = [r.alarms] if r.alarms else []

        feed_items.append(
            FeedItemResponse(
                id=r.id,
                code=r.code,
                role=r.role,
                lat=r.lat,
                lng=r.lng,
                timestamp=r.timestamp,
                alarms=alarms_list,
                device_id=r.device_id,
                created_at=r.created_at,
            )
        )
    return feed_items


@router.get("/health")
def health_check() -> Any:
    return {"status": "healthy", "service": "sensoo-backend"}
