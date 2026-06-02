import asyncio
import shutil
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from backend.database import Folio, Job, Line

GT_DIR = Path(__file__).parent.parent.parent / "data" / "gt"
COMPILED_DIR = Path(__file__).parent.parent.parent / "data" / "compiled"


def write_gt_files(dataset_id: int, db: Session) -> list[Path]:
    """Write .gt.txt + symlinked image for every confirmed Line in the dataset."""
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).all()
    folio_ids = [f.id for f in folios]

    written = []
    for folio_id in folio_ids:
        lines = (
            db.query(Line)
            .filter(Line.folio_id == folio_id, Line.confirmed == True)
            .order_by(Line.line_index)
            .all()
        )
        for line in lines:
            if not line.transcription or not line.crop_path:
                continue
            crop = Path(line.crop_path)
            if not crop.exists():
                continue

            gt_dir = GT_DIR / str(folio_id)
            gt_dir.mkdir(parents=True, exist_ok=True)

            gt_img = gt_dir / crop.name
            gt_txt = gt_dir / (crop.stem + ".gt.txt")

            # Hard-link or copy image next to .gt.txt
            if not gt_img.exists():
                shutil.copy2(crop, gt_img)

            gt_txt.write_text(line.transcription, encoding="utf-8")
            written.append(gt_txt)

    return written


async def compile_dataset(dataset_id: int, db: Session) -> Job:
    """Write GT files then run `ketos compile` to produce an .arrow file."""
    gt_files = write_gt_files(dataset_id, db)
    if not gt_files:
        raise ValueError("No confirmed lines with transcriptions found")

    COMPILED_DIR.mkdir(parents=True, exist_ok=True)
    arrow_out = COMPILED_DIR / f"dataset_{dataset_id}.arrow"

    job = Job(type="compile", status="running", dataset_id=dataset_id,
              started_at=datetime.utcnow())
    db.add(job)
    db.commit()
    db.refresh(job)

    log_path = COMPILED_DIR / f"compile_{job.id}.log"
    job.log_path = str(log_path)
    db.commit()

    # Build file list: ketos compile accepts image files and discovers .gt.txt siblings
    img_files = [str(p).replace(".gt.txt", ".png") for p in gt_files
                 if Path(str(p).replace(".gt.txt", ".png")).exists()]

    cmd = [
        "ketos", "compile",
        "--random-split", "0.9", "0.05", "0.05",
        "-o", str(arrow_out),
        *img_files,
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        log_path.write_bytes(stdout)

        if proc.returncode == 0:
            job.status = "done"
            job.model_path = str(arrow_out)
        else:
            job.status = "failed"
    except Exception as exc:
        log_path.write_text(str(exc))
        job.status = "failed"

    job.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return job
