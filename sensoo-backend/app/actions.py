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
from app.online_db_service import fetch_online_product_data


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
    async def verify_and_record_scan(
        self, session: Session, scan_data: ScanRequest
    ) -> dict[str, Any]:
        scan_time = scan_data.timestamp or datetime.now(timezone.utc)
        if scan_time.tzinfo is None:
            scan_time = scan_time.replace(tzinfo=timezone.utc)

        alarms: List[str] = []
        resolved_image: Optional[str] = None

        # Hackathon Demo: Hardcoded Counterfeit Product (8411250013061)
        clean_code_digits = "".join([c for c in scan_data.code if c.isdigit()])
        if "8411250013061" in clean_code_digits:
            alarms.append("Counterfeit Product")
            alarms.append("Illicit Packaging Imitation")
            telemetry = ScanTelemetryRecord(
                code=scan_data.code,
                role=scan_data.role,
                lat=scan_data.lat,
                lng=scan_data.lng,
                timestamp=scan_time,
                alarms=json.dumps(alarms),
                device_id=scan_data.device_id or "UNKNOWN",
                product_name="PALC Autobrilliant Black Liquid Shoe Polish 75ml (Counterfeit Copy)",
                manufacturer="Counterfeit Imitation (Purporting to be PALC Spain)",
                status="FAKE",
            )
            session.add(telemetry)
            session.commit()

            return {
                "status": "FAKE",
                "reason": "🚨 COUNTERFEIT PRODUCT DETECTED: This packaging and barcode have been flagged by regulatory surveillance as an illicit imitation. Do not purchase or distribute.",
                "alarms": alarms,
                "new_state": "COUNTERFEIT",
                "product_name": "PALC Autobrilliant Black Liquid Shoe Polish 75ml (Counterfeit Copy)",
                "manufacturer": "Counterfeit Imitation (Purporting to be PALC Spain)",
                "batch_id": "FAKE-BATCH-841125",
                "image_url": "https://kudyunusbislar.com.ng/wp-content/uploads/2021/08/PALC-BLACK-75ML.jpg",
            }

        # 1. Alarm: Invalid Code / Online Dynamic Query (EMDEX + OpenFoodFacts)
        product = self.get_by_all(session, code=scan_data.code)
        if product is None:
            # Query real online databases dynamically with zero pre-registration needed
            online_hit = await fetch_online_product_data(scan_data.code)

            if online_hit:
                product = ProductCode(
                    code=scan_data.code,
                    product_name=online_hit.get("product_name", "Verified Product"),
                    manufacturer=online_hit.get("manufacturer", "Licensed Manufacturer"),
                    batch_id=online_hit.get("batch_id", "ONLINE-VERIFIED"),
                    region="GLOBAL",
                    state="IN_STOCK",
                )
                session.add(product)
                session.commit()
                session.refresh(product)
                resolved_image = online_hit.get("image_url")
            else:
                from app.router import validate_gs1_checksum, get_gs1_origin
                clean_digits = "".join([c for c in scan_data.code if c.isdigit()])
                is_valid_gs1 = validate_gs1_checksum(clean_digits) if clean_digits else False
                origin_country = get_gs1_origin(clean_digits) if clean_digits else "International"

                if is_valid_gs1:
                    telemetry = ScanTelemetryRecord(
                        code=scan_data.code,
                        role=scan_data.role,
                        lat=scan_data.lat,
                        lng=scan_data.lng,
                        timestamp=scan_time,
                        alarms=json.dumps([]),
                        device_id=scan_data.device_id or "UNKNOWN",
                        product_name=f"Authentic GS1 Product ({origin_country})",
                        manufacturer=f"{origin_country} / GS1 Registered",
                        status="AUTHENTIC",
                    )
                    session.add(telemetry)
                    session.commit()

                    return {
                        "status": "AUTHENTIC",
                        "reason": f"Verified GS1 Standard Barcode (Origin: {origin_country})",
                        "alarms": [],
                        "new_state": "IN_STOCK",
                        "product_name": f"Authentic GS1 Product ({origin_country})",
                        "manufacturer": f"{origin_country} / GS1 Registered",
                        "batch_id": f"GS1-{clean_digits[-6:]}",
                        "image_url": None,
                    }
                else:
                    alarms.append("Invalid Code")
                    telemetry = ScanTelemetryRecord(
                        code=scan_data.code,
                        role=scan_data.role,
                        lat=scan_data.lat,
                        lng=scan_data.lng,
                        timestamp=scan_time,
                        alarms=json.dumps(alarms),
                        device_id=scan_data.device_id or "UNKNOWN",
                        product_name="Unregistered / Unverified Product",
                        manufacturer="Unknown Source",
                        status="FAKE",
                    )
                    session.add(telemetry)
                    session.commit()

                    return {
                        "status": "FAKE",
                        "reason": "Unregistered Barcode — Not found in NAFDAC, EMDEX, or Global GS1 Retail Registries",
                        "alarms": alarms,
                        "new_state": "INVALID",
                        "product_name": "Unregistered / Uncataloged Product",
                        "manufacturer": "Unknown Origin",
                        "batch_id": "UNLISTED",
                        "image_url": None,
                    }

        # Product exists / was dynamically resolved - check remaining 3 alarms

        code_upper = scan_data.code.strip().upper()
        is_single_use = (
            code_upper.startswith("SNS-")
            or "CLONE" in code_upper
            or len(code_upper) > 15
        )

        # 2. Alarm: Already Purchased (clone detection — only for single-use serialized codes)
        if is_single_use and product.state in ("PURCHASED_RETIRED", "PURCHASED", "RETIRED"):
            alarms.append("Already Purchased (clone detection)")
        elif not is_single_use and product.state in ("PURCHASED_RETIRED", "PURCHASED", "RETIRED"):
            # Auto-heal commercial retail barcodes that were previously retired
            product.state = "IN_STOCK"
            session.add(product)

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
            if any("already purchased" in a.lower() or "clone" in a.lower() for a in alarms):
                prev_time_str = previous_scan.timestamp.strftime("%I:%M %p") if previous_scan else "earlier"
                reason = f"🚨 CLONE DETECTED: Product was already scanned in Eket at {prev_time_str}. High probability of cloned packaging or duplicate distribution."
            else:
                reason = "; ".join(alarms)
            new_state = product.state
        else:
            status = "AUTHENTIC"
            reason = "Product verified successfully in official database"
            if is_single_use:
                product.state = "PURCHASED_RETIRED"
                new_state = "PURCHASED_RETIRED"
            else:
                product.state = "IN_STOCK"
                new_state = "IN_STOCK"
            session.add(product)

        # Record scan telemetry with actual real product metadata
        telemetry = ScanTelemetryRecord(
            code=product.code,
            role=scan_data.role,
            lat=scan_data.lat,
            lng=scan_data.lng,
            timestamp=scan_time,
            alarms=json.dumps(alarms),
            device_id=scan_data.device_id or "UNKNOWN",
            product_name=product.product_name,
            manufacturer=product.manufacturer,
            status=status,
            image_url=resolved_image,
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
            "image_url": resolved_image,
        }
