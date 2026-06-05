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
SEG_GT_DIR = Path(__file__).parent.parent.parent / "data" / "seg_gt"


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


# ── Segmentation GT ───────────────────────────────────────────────────────────

def _derive_baseline(polygon: list) -> list:
    """Synthesise a horizontal baseline from a boundary polygon.

    Used for lines whose kraken baseline was not stored (e.g. manually-added
    lines).  Returns two points spanning the polygon's x extent at 75 % of
    the height — consistent with the value used for recognition ALTO.
    """
    if not polygon:
        return []
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    baseline_y = int(y_min + (y_max - y_min) * 0.75)
    return [[x_min, baseline_y], [x_max, baseline_y]]


def _write_seg_alto_xml(
    xml_path: Path,
    img_path: Path,
    page_w: int,
    page_h: int,
    line_data: list,          # [(polygon, baseline), ...]
) -> None:
    """Write a full-page ALTO 4 XML for segmentation training.

    Each confirmed line contributes one TextLine with its actual boundary
    polygon and baseline.  ketos segtrain -f alto reads these directly.
    """
    line_elements = []
    for i, (polygon, baseline) in enumerate(line_data):
        if not polygon or len(polygon) < 3:
            continue
        poly_pts = " ".join(f"{int(p[0])} {int(p[1])}" for p in polygon)
        bl_pts = " ".join(f"{int(p[0])} {int(p[1])}" for p in baseline)
        line_elements.append(
            f'          <TextLine ID="line_{i}" BASELINE="{bl_pts}">\n'
            f'            <Shape><Polygon POINTS="{poly_pts}"/></Shape>\n'
            f'          </TextLine>'
        )

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
            <Page WIDTH="{page_w}" HEIGHT="{page_h}" PHYSICAL_IMG_NR="0" ID="page_0">
              <PrintSpace HPOS="0" VPOS="0" WIDTH="{page_w}" HEIGHT="{page_h}">
                <TextBlock HPOS="0" VPOS="0" WIDTH="{page_w}" HEIGHT="{page_h}" ID="block_0">
    {chr(10).join(line_elements)}
                </TextBlock>
              </PrintSpace>
            </Page>
          </Layout>
        </alto>
    """)
    xml_path.write_text(xml, encoding="utf-8")


def write_seg_gt_files(dataset_id: int, db: Session) -> list[Path]:
    """Write one full-page ALTO XML per folio for segmentation training.

    Uses the actual stored baseline where available (from kraken's segmenter
    output); falls back to a synthesised horizontal baseline for manually-added
    or edited lines that predate baseline storage.
    """
    folios = db.query(Folio).filter(Folio.dataset_id == dataset_id).all()

    xml_files: list[Path] = []
    for folio in folios:
        if not folio.local_image_path:
            continue
        img_path = Path(folio.local_image_path)
        if not img_path.exists():
            continue

        confirmed_lines = (
            db.query(Line)
            .filter(Line.folio_id == folio.id, Line.confirmed == True)
            .order_by(Line.line_index)
            .all()
        )
        if not confirmed_lines:
            continue

        with Image.open(img_path) as im:
            page_w, page_h = im.size

        line_data = []
        for line in confirmed_lines:
            polygon = line.get_polygon()
            baseline = line.get_baseline()
            if not baseline:
                baseline = _derive_baseline(polygon)
            line_data.append((polygon, baseline))

        seg_dir = SEG_GT_DIR / str(dataset_id)
        seg_dir.mkdir(parents=True, exist_ok=True)

        xml_path = seg_dir / f"folio_{folio.id}.xml"
        _write_seg_alto_xml(xml_path, img_path, page_w, page_h, line_data)
        xml_files.append(xml_path)

    return xml_files


def compile_seg_dataset(dataset_id: int, db: Session) -> Job:
    """Prepare per-folio ALTO XML files for `ketos segtrain`.

    Unlike recognition training (which needs a pre-compiled .arrow), segtrain
    consumes the ALTO XMLs directly.  We write a manifest so the trainer can
    find the files without re-scanning the directory.
    """
    xml_files = write_seg_gt_files(dataset_id, db)
    if not xml_files:
        raise ValueError(
            "No confirmed lines found. Confirm at least one line on each page "
            "you want to include in segmentation training."
        )

    COMPILED_DIR.mkdir(parents=True, exist_ok=True)
    manifest = COMPILED_DIR / f"seg_dataset_{dataset_id}.txt"
    manifest.write_text("\n".join(str(p) for p in xml_files), encoding="utf-8")

    job = Job(
        type="compile_seg",
        status="done",
        dataset_id=dataset_id,
        started_at=datetime.utcnow(),
        finished_at=datetime.utcnow(),
        model_path=str(manifest),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    log_path = COMPILED_DIR / f"compile_seg_{job.id}.log"
    log_path.write_text(
        f"Segmentation GT prepared: {len(xml_files)} page(s)\n"
        f"Manifest: {manifest}\n\n"
        + "\n".join(str(p) for p in xml_files),
        encoding="utf-8",
    )
    job.log_path = str(log_path)
    db.commit()

    return job
