from datetime import datetime, timezone
from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict
from sqlmodel import Field
from msflib.models import ModelBase


class ProductCode(ModelBase, table=True):
    code: str = Field(index=True, unique=True)
    product_name: str
    manufacturer: str
    batch_id: str
    region: str = Field(default="GLOBAL")
    state: str = Field(default="IN_STOCK")


class ScanTelemetryRecord(ModelBase, table=True):
    code: str = Field(index=True)
    role: str = Field(default="CONSUMER")
    lat: float
    lng: float
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    alarms: str = Field(default="[]")
    device_id: str = Field(default="UNKNOWN")


class ProductCodeCreate(BaseModel):
    code: str
    product_name: str
    manufacturer: str
    batch_id: str
    region: str = "GLOBAL"
    state: str = "IN_STOCK"


class ProductCodeUpdate(BaseModel):
    product_name: Optional[str] = None
    manufacturer: Optional[str] = None
    batch_id: Optional[str] = None
    region: Optional[str] = None
    state: Optional[str] = None


class ScanRequest(BaseModel):
    code: str
    role: str = "CONSUMER"
    lat: float
    lng: float
    timestamp: Optional[datetime] = None
    device_id: Optional[str] = "UNKNOWN"
    region: Optional[str] = None


class ScanResponse(BaseModel):
    status: str
    reason: str
    alarms: List[str]
    new_state: str
    product_name: str
    manufacturer: str
    batch_id: str


class FeedItemResponse(BaseModel):
    id: Optional[int] = None
    code: str
    role: str
    lat: float
    lng: float
    timestamp: datetime
    alarms: List[str]
    device_id: str
    created_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)
