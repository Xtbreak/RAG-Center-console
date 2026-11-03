from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class ModelPriceInput(BaseModel):
    model_id: str
    input_price_per_million: Decimal = Field(ge=0, le=1000000)
    output_price_per_million: Decimal = Field(ge=0, le=1000000)
    currency: Literal["CNY", "USD"] = "CNY"


class ModelPriceRead(ModelPriceInput):
    model_name: str
    provider: str
    model_type: str
    enabled: bool
    updated_at: datetime | None
