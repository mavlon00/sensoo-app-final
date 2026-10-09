from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlmodel import Session, select
from msflib.eventbus import bind_app_emitter

from app.db import engine, init_db
from app.models import ProductCode
from app.router import router


def seed_demo_products() -> None:
    demo_products = [
        ProductCode(
            code="UNL-9X4-B2P",
            product_name="Dove Body Wash 250ml",
            manufacturer="Unilever",
            batch_id="BATCH-9X4",
            region="GLOBAL",
            state="IN_STOCK",
        ),
        ProductCode(
            code="UNL-CLONE-01",
            product_name="Panadol Extra",
            manufacturer="GSK",
            batch_id="BATCH-CLN",
            region="GLOBAL",
            state="PURCHASED_RETIRED",
        ),
        ProductCode(
            code="UNL-FAST-99",
            product_name="Dettol",
            manufacturer="Reckitt",
            batch_id="BATCH-F99",
            region="GLOBAL",
            state="IN_STOCK",
        ),
    ]
    with Session(engine) as session:
        for product in demo_products:
            existing = session.exec(
                select(ProductCode).where(ProductCode.code == product.code)
            ).first()
            if not existing:
                session.add(product)
        session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_demo_products()
    yield


app = FastAPI(
    title="Sensoo Backend",
    version="1.0.0",
    lifespan=lifespan,
)

# Bind MSFLib event emitter to app instance
bind_app_emitter(app)

app.include_router(router)


@app.get("/")
def root():
    return {"message": "Sensoo Backend API is running"}
