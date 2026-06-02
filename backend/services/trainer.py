import asyncio
import os
import signal
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

from sqlalchemy.orm import Session

from backend.database import Job

MODELS_DIR = Path(__file__).parent.parent.parent / "data" / "models"
COMPILED_DIR = Path(__file__).parent.parent.parent / "data" / "compiled"
LOGS_DIR = Path(__file__).parent.parent.parent / "data" / "logs"

MODELS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# Active subprocesses keyed by job_id
_procs: dict[int, asyncio.subprocess.Process] = {}


async def start_training(
    dataset_id: int,
    output_name: str,
    epochs: int,
    base_model: str | None,
    db: Session,
) -> Job:
    arrow_path = COMPILED_DIR / f"dataset_{dataset_id}.arrow"
    if not arrow_path.exists():
        raise FileNotFoundError(f"Compiled dataset not found: {arrow_path}")

    model_out = MODELS_DIR / output_name
    model_out.mkdir(parents=True, exist_ok=True)

    job = Job(type="train", status="running", dataset_id=dataset_id,
              started_at=datetime.utcnow())
    db.add(job)
    db.commit()
    db.refresh(job)

    log_path = LOGS_DIR / f"train_{job.id}.log"
    job.log_path = str(log_path)
    job.set_extra({"output_name": output_name, "epochs": epochs})
    db.commit()

    cmd = [
        "ketos", "train",
        "-o", str(model_out / "model"),
        "--epochs", str(epochs),
        str(arrow_path),
    ]
    if base_model:
        cmd = cmd[:2] + ["--load", base_model] + cmd[2:]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    _procs[job.id] = proc
    job.pid = proc.pid
    db.commit()

    # Stream logs to file in background
    asyncio.create_task(_stream_to_file(proc, log_path, job.id, db))

    db.refresh(job)
    return job


async def _stream_to_file(
    proc: asyncio.subprocess.Process,
    log_path: Path,
    job_id: int,
    db: Session,
):
    with open(log_path, "wb") as f:
        async for line in proc.stdout:
            f.write(line)
            f.flush()

    await proc.wait()
    _procs.pop(job_id, None)

    job = db.query(Job).filter(Job.id == job_id).first()
    if job:
        if proc.returncode == 0:
            job.status = "done"
        elif proc.returncode == -signal.SIGTERM or job.status == "stopped":
            job.status = "stopped"
        else:
            job.status = "failed"
        job.finished_at = datetime.utcnow()
        db.commit()


async def stream_logs(job_id: int, db: Session) -> AsyncIterator[str]:
    """
    Async generator yielding log lines as SSE data.
    First replays the existing log file, then tails new lines until the job ends.
    """
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job or not job.log_path:
        return

    log_path = Path(job.log_path)

    # Replay existing content
    if log_path.exists():
        with open(log_path, "r", errors="replace") as f:
            for line in f:
                yield line.rstrip("\n")

    # Tail new content while process is running
    if job_id in _procs:
        proc = _procs[job_id]
        try:
            async for line in proc.stdout:
                yield line.decode(errors="replace").rstrip("\n")
        except Exception:
            pass


def stop_job(job_id: int, db: Session) -> bool:
    proc = _procs.get(job_id)
    if proc:
        proc.terminate()
        job = db.query(Job).filter(Job.id == job_id).first()
        if job:
            job.status = "stopped"
            db.commit()
        return True
    return False
