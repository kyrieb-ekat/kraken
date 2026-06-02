import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import Job, get_db
from backend.services import gt_builder, trainer

router = APIRouter(prefix="/training", tags=["training"])


# ── Compile ground truth ───────────────────────────────────────────────────────

@router.post("/compile/{dataset_id}")
async def compile_gt(dataset_id: int, db: Session = Depends(get_db)):
    try:
        job = await gt_builder.compile_dataset(dataset_id, db)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))
    return {"job_id": job.id, "status": job.status}


# ── Training ──────────────────────────────────────────────────────────────────

class TrainRequest(BaseModel):
    dataset_id: int
    output_name: str
    epochs: int = 50
    base_model: str | None = None


@router.post("/start")
async def start_training(body: TrainRequest, db: Session = Depends(get_db)):
    try:
        job = await trainer.start_training(
            dataset_id=body.dataset_id,
            output_name=body.output_name,
            epochs=body.epochs,
            base_model=body.base_model,
            db=db,
        )
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))
    return {"job_id": job.id, "pid": job.pid, "status": job.status}


@router.post("/jobs/{job_id}/stop")
def stop_job(job_id: int, db: Session = Depends(get_db)):
    stopped = trainer.stop_job(job_id, db)
    return {"stopped": stopped}


@router.get("/jobs/{job_id}/status")
def job_status(job_id: int, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(404, "Job not found")
    return {
        "id": job.id,
        "type": job.type,
        "status": job.status,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.get("/jobs/{job_id}/logs")
async def stream_logs(job_id: int, db: Session = Depends(get_db)):
    """Server-Sent Events endpoint for live training logs."""
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(404, "Job not found")

    async def event_stream():
        async for line in trainer.stream_logs(job_id, db):
            yield f"data: {line}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db)):
    jobs = db.query(Job).order_by(Job.id.desc()).limit(50).all()
    return [
        {
            "id": j.id,
            "type": j.type,
            "status": j.status,
            "dataset_id": j.dataset_id,
            "started_at": j.started_at.isoformat() if j.started_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            "model_path": j.model_path,
        }
        for j in jobs
    ]
