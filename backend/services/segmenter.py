import asyncio
import json
import tempfile
from pathlib import Path

from PIL import Image
from sqlalchemy.orm import Session

from backend.database import Folio, Line

LINES_DIR = Path(__file__).parent.parent.parent / "data" / "lines"


def folio_lines_dir(folio_id: int) -> Path:
    d = LINES_DIR / str(folio_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


async def segment_folio(folio: Folio, db: Session) -> list[int]:
    """
    Run `kraken segment -bl` on the folio image, crop line images,
    insert Line rows, and return the list of new line IDs.
    """
    if not folio.local_image_path:
        raise ValueError("Folio has no local image")

    image_path = Path(folio.local_image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    # Run Kraken segmentation
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
        seg_out = tf.name

    proc = await asyncio.create_subprocess_exec(
        "kraken", "-i", str(image_path), seg_out, "segment", "-bl",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"kraken segment failed: {stderr.decode()}")

    with open(seg_out) as f:
        seg_data = json.load(f)

    Path(seg_out).unlink(missing_ok=True)

    # Kraken segment JSON format: {"lines": [{"baseline": [...], "boundary": [...], ...}, ...]}
    lines_data = seg_data.get("lines", [])

    # Remove existing lines for this folio (re-segment)
    db.query(Line).filter(Line.folio_id == folio.id).delete()
    db.commit()

    page_img = Image.open(image_path).convert("RGB")
    lines_dir = folio_lines_dir(folio.id)

    # Distribute the text pool sequentially as unconfirmed suggestions
    text_pool = folio.get_text_pool()
    new_ids = []

    for idx, line_info in enumerate(lines_data):
        boundary = line_info.get("boundary", [])
        baseline = line_info.get("baseline", [])
        polygon = boundary or baseline

        crop_path = _crop_line(page_img, boundary, lines_dir, folio.id, idx)

        suggestion = text_pool[idx] if idx < len(text_pool) else None

        line = Line(
            folio_id=folio.id,
            line_index=idx,
            crop_path=str(crop_path) if crop_path else None,
            transcription=suggestion,
            confirmed=False,
        )
        line.set_polygon(polygon)
        db.add(line)
        db.flush()
        new_ids.append(line.id)

    folio.segmented = True
    db.commit()
    return new_ids


def _crop_line(page_img: Image.Image, boundary: list, lines_dir: Path, folio_id: int, idx: int) -> Path | None:
    """Crop a line from the page image using its bounding polygon, save as PNG."""
    if not boundary:
        return None

    xs = [p[0] for p in boundary]
    ys = [p[1] for p in boundary]
    if not xs or not ys:
        return None

    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    # Clamp to image bounds
    w, h = page_img.size
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    if x1 <= x0 or y1 <= y0:
        return None

    crop = page_img.crop((x0, y0, x1, y1))
    dest = lines_dir / f"line_{idx:04d}.png"
    crop.save(dest)
    return dest


def split_line(line: Line, x_ratio: float, page_image_path: str, db: Session) -> tuple[Line, Line]:
    """
    Split a Line horizontally at x_ratio (0.0–1.0 of the crop width).
    Deletes the original line and returns two new Line objects.
    """
    folio_id = line.folio_id
    polygon = line.get_polygon()
    lines_dir = folio_lines_dir(folio_id)

    page_img = Image.open(page_image_path).convert("RGB")

    if not polygon:
        raise ValueError("Line has no polygon, cannot split")

    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    w, h = page_img.size
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    split_x = int(x0 + (x1 - x0) * x_ratio)

    # Determine new indices — insert after current line_index
    existing_max = db.query(Line).filter(Line.folio_id == folio_id).count()
    idx_a = line.line_index
    idx_b = existing_max  # append at end, UI orders by line_index

    crop_a = page_img.crop((x0, y0, split_x, y1))
    crop_b = page_img.crop((split_x, y0, x1, y1))

    path_a = lines_dir / f"line_{idx_a:04d}_a.png"
    path_b = lines_dir / f"line_{idx_b:04d}_b.png"
    crop_a.save(path_a)
    crop_b.save(path_b)

    poly_a = [[x0, y0], [split_x, y0], [split_x, y1], [x0, y1]]
    poly_b = [[split_x, y0], [x1, y0], [x1, y1], [split_x, y1]]

    line_a = Line(folio_id=folio_id, line_index=idx_a, crop_path=str(path_a),
                  transcription=line.transcription, confirmed=False)
    line_a.set_polygon(poly_a)

    line_b = Line(folio_id=folio_id, line_index=idx_b, crop_path=str(path_b),
                  transcription=None, confirmed=False)
    line_b.set_polygon(poly_b)

    db.delete(line)
    db.add(line_a)
    db.add(line_b)
    db.commit()
    db.refresh(line_a)
    db.refresh(line_b)
    return line_a, line_b


def merge_lines(line_a: Line, line_b: Line, page_image_path: str, db: Session) -> Line:
    """
    Merge two lines into one by taking the union bounding box.
    Concatenates transcription text (space-separated). Returns the merged Line.
    """
    folio_id = line_a.folio_id
    lines_dir = folio_lines_dir(folio_id)
    page_img = Image.open(page_image_path).convert("RGB")

    def bbox(line):
        pts = line.get_polygon()
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return min(xs), min(ys), max(xs), max(ys)

    bb_a = bbox(line_a)
    bb_b = bbox(line_b)
    if not bb_a or not bb_b:
        raise ValueError("Cannot merge lines without polygon data")

    x0 = min(bb_a[0], bb_b[0])
    y0 = min(bb_a[1], bb_b[1])
    x1 = max(bb_a[2], bb_b[2])
    y1 = max(bb_a[3], bb_b[3])
    w, h = page_img.size
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)

    merged_crop = page_img.crop((x0, y0, x1, y1))
    idx = min(line_a.line_index, line_b.line_index)
    path = lines_dir / f"line_{idx:04d}_merged.png"
    merged_crop.save(path)

    texts = [t for t in [line_a.transcription, line_b.transcription] if t]
    merged_text = " ".join(texts) or None

    merged = Line(folio_id=folio_id, line_index=idx, crop_path=str(path),
                  transcription=merged_text, confirmed=False)
    merged.set_polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])

    db.delete(line_a)
    db.delete(line_b)
    db.add(merged)
    db.commit()
    db.refresh(merged)
    return merged
