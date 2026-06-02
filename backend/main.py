from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.routers import datasets, models, segmentation, training, transcriptions

DATA_DIR = Path(__file__).parent.parent / "data"
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

app = FastAPI(title="Kraken Training Interface", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(datasets.router)
app.include_router(segmentation.router)
app.include_router(transcriptions.router)
app.include_router(training.router)
app.include_router(models.router)

# Serve data files (images, line crops) under /static
app.mount("/static", StaticFiles(directory=str(DATA_DIR)), name="static")

# Serve the frontend SPA — must be last so API routes take priority
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
