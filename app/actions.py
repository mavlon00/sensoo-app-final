from datetime import datetime, timezone
import json
import math
from typing import Any, List, Optional
from sqlmodel import Session, select
from msflib.actions import ModelAction

from app.models import (
    ProductCode,
    ProductCodeCreate,
    ProductCodeUpdate,
    ScanRequest,
    ScanResponse,
    ScanTelemetryRecord,
)


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great circle distance between two points on the earth in kilometers."""
    R = 6371.0  # Earth radius in kilometers
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


class VerificationAction(ModelAction[ProductCode, ProductCodeCreate, ProductCodeUpdate]):
    def verify_and_record_scan(
        self, session: Session, scan_data: ScanRequest
    ) -> dict[str, Any]:
        scan_time = scan_data.timestamp or datetime.now(timezone.utc)
        if scan_time.tzinfo is None:
            scan_time = scan_time.replace(tzinfo=timezone.utc)

        alarms: List[str] = []

        # 1. Alarm: Invalid Code
        product = self.get_by_all(session, code=scan_data.code)
        if product is None:
            alarms.append("Invalid Code")
            telemetry = ScanTelemetryRecord(
                code=scan_data.code,
                role=scan_data.role,
                lat=scan_data.lat,
                lng=scan_data.lng,
                timestamp=scan_time,
                alarms=json.dumps(alarms),
                device_id=scan_data.device_id or "UNKNOWN",
            )
            session.add(telemetry)
            session.commit()

            return {
                "status": "FAKE",
                "reason": "Invalid Product Code",
                "alarms": alarms,
                "new_state": "INVALID",
                "product_name": "Unknown",
                "manufacturer": "Unknown",
                "batch_id": "Unknown",
            }

        # Product exists - check remaining 3 alarms

        # 2. Alarm: Already Purchased (clone detection)
        if product.state in ("PURCHASED_RETIRED", "PURCHASED", "RETIRED"):
            alarms.append("Already Purchased (clone detection)")

        # 3. Alarm: Impossible Physics (Haversine formula, threshold 900 km/h)
        stmt = (
            select(ScanTelemetryRecord)
            .where(ScanTelemetryRecord.code == product.code)
            .order_by(ScanTelemetryRecord.timestamp.desc(), ScanTelemetryRecord.id.desc())
        )
        previous_scan = session.exec(stmt).first()

        if previous_scan:
            prev_time = previous_scan.timestamp
            if prev_time.tzinfo is None:
                prev_time = prev_time.replace(tzinfo=timezone.utc)

            time_diff_seconds = abs((scan_time - prev_time).total_seconds())
            dist_km = haversine(previous_scan.lat, previous_scan.lng, scan_data.lat, scan_data.lng)

            if time_diff_seconds > 0:
                speed_kmh = dist_km / (time_diff_seconds / 3600.0)
            else:
                speed_kmh = 999999.0 if dist_km > 0.001 else 0.0

            if speed_kmh > 900.0:
                alarms.append("Impossible Physics (Haversine formula, threshold 900 km/h)")

        # 4. Alarm: Wrong Region
        if scan_data.region:
            if (
                product.region.strip().upper() != "GLOBAL"
                and scan_data.region.strip().upper() != product.region.strip().upper()
            ):
                alarms.append("Wrong Region")

        # Determine verification result
        if alarms:
            status = "FAKE"
            reason = "; ".join(alarms)
            new_state = product.state
        else:
            status = "AUTHENTIC"
            reason = "Product verified successfully"
            product.state = "PURCHASED_RETIRED"
            new_state = "PURCHASED_RETIRED"
            session.add(product)

        # Record scan telemetry
        telemetry = ScanTelemetryRecord(
            code=product.code,
            role=scan_data.role,
            lat=scan_data.lat,
            lng=scan_data.lng,
            timestamp=scan_time,
            alarms=json.dumps(alarms),
            device_id=scan_data.device_id or "UNKNOWN",
        )
        session.add(telemetry)
        session.commit()
        if not alarms:
            session.refresh(product)

        return {
            "status": status,
            "reason": reason,
            "alarms": alarms,
            "new_state": new_state,
            "product_name": product.product_name,
            "manufacturer": product.manufacturer,
            "batch_id": product.batch_id,
        }
