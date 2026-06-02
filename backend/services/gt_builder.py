import asyncio
import shutil
import textwrap
from datetime import datetime
from pathlib import Path

from PIL import Image
from sqlalchemy.orm import Session

from backend.database import Folio, Job, Line

GT_DIR = Path(__file__).parent.parent.parent / "data" / "gt"
COMPILED_DIR = Path(__file__).parent.parent.parent / "data" / "compiled"


def _write_alto_xml(xml_path: Path, img_path: Path, transcription: str) -> None:
    """Write a minimal ALTO 4 XML file for a single line crop.

    ketos compile -f alto parses TextLine elements in baseline mode by default.
    It requires a BASELINE attribute (x0 y0 x1 y1 … point sequence) on each
    TextLine or it silently skips the line.  We synthesise a straight horizontal
    baseline at 75 % of the image height — reasonable for most manuscript hands.
    A Shape/Polygon covering the full image is included as the boundary so
    kraken has a complete region to extract from.
    """
    with Image.open(img_path) as im:
        w, h = im.size

    # Use w-1 / h-1: kraken's extract_polygons treats coordinates as pixel
    # indices (0-based), so a point at (w, h) is one pixel outside the image.
    w1, h1 = w - 1, h - 1
    baseline_y = int(h1 * 0.75)

    # Escape XML special characters in the transcription
    text = (transcription
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))

    xml = textwrap.dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
          <Description>
            <MeasurementUnit>pixel</MeasurementUnit>
            <sourceImageInformation>
              <fileName>{img_path.resolve()}</fileName>
            </sourceImageInformation>
          </Description>
          <Layout>
            <Page WIDTH="{w}" HEIGHT="{h}" PHYSICAL_IMG_NR="0" ID="page_0">
              <PrintSpace HPOS="0" VPOS="0" WIDTH="{w}" HEIGHT="{h}">
                <TextBlock HPOS="0" VPOS="0" WIDTH="{w}" HEIGHT="{h}" ID="block_0">
                  <TextLine HPOS="0" VPOS="0" WIDTH="{w}" HEIGHT="{h}" ID="line_0"
                            BASELINE="0 {baseline_y} {w1} {baseline_y}">
                    <Shape>
                      <Polygon POINTS="0 0 {w1} 0 {w1} {h1} 0 {h1}"/>
                    </Shape>
                    <String CONTENT="{text}"/>
                  </TextLine>
                </TextBlock>
              </PrintSpace>
            </Page>
          </Layout>
        </alto>
    """)
    xml_path.write_text(xml, encoding="utf-8")


def write_gt_files(dataset_id: int, db: Session) -> list[Path]:
    """Write an ALTO XML + copied image for every confirmed Line in the dataset.

    Returns the list of XML paths written (each has a corresponding .png).
    """
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).all()

    xml_files: list[Path] = []
    for folio in folios:
        lines = (
            db.query(Line)
            .filter(Line.folio_id == folio.id, Line.confirmed == True)
            .order_by(Line.line_index)
            .all()
        )
        for line in lines:
            if not line.transcription or not line.crop_path:
                continue
            crop = Path(line.crop_path)
            if not crop.exists():
                continue

            gt_dir = GT_DIR / str(folio.id)
            gt_dir.mkdir(parents=True, exist_ok=True)

            gt_img = gt_dir / crop.name
            gt_xml = gt_dir / (crop.stem + ".xml")

            if not gt_img.exists():
                shutil.copy2(crop, gt_img)

            _write_alto_xml(gt_xml, gt_img, line.transcription)
            xml_files.append(gt_xml)

    return xml_files


async def compile_dataset(dataset_id: int, db: Session) -> Job:
    """Write ALTO XML ground-truth files then run `ketos compile -f alto` to
    produce a binary .arrow dataset.

    ketos train accepts this with `-f binary`.  The --force-type bbox flag
    tells kraken our data is line-strip (crop) style rather than full-page
    baseline polygons.
    """
    xml_files = write_gt_files(dataset_id, db)
    if not xml_files:
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

    cmd = [
        "ketos", "compile",
        "-f", "alto",
        "-o", str(arrow_out),
        *[str(p) for p in xml_files],
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
            existing = log_path.read_bytes() if log_path.exists() else b""
            header = f"Command: {' '.join(cmd)}\nExit code: {proc.returncode}\n\n".encode()
            log_path.write_bytes(header + existing)
            job.status = "failed"
    except Exception:
        import traceback
        log_path.write_text(
            f"Command: {' '.join(cmd)}\n\n{traceback.format_exc()}",
            encoding="utf-8",
        )
        job.status = "failed"

    job.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return job
