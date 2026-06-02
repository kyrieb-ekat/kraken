import csv
import io


def parse_cantus_csv(content: bytes) -> dict[str, dict]:
    """
    Parse a Cantus Database CSV export.
    Returns a dict keyed by folio_label:
      {
        folio_label: {
          image_url: str | None,
          text_pool: [fulltext_ms, ...]   # ordered by 'sequence' field
        }
      }
    Multiple rows with the same (folio, image_link) are aggregated.
    Rows are sorted by the 'sequence' field so text_pool reflects physical
    page order — critical for finding the last chant on a page correctly.
    """
    text = content.decode("utf-8-sig")  # handle BOM if present
    reader = csv.DictReader(io.StringIO(text))

    # Store (sequence, text_ms) tuples so we can sort by physical position
    by_url: dict[str, dict] = {}       # image_url -> folio dict
    by_label: dict[str, dict] = {}     # folio_label -> folio dict (no-url rows)

    for row in reader:
        folio_label = (row.get("folio") or "").strip()
        image_url = (row.get("image_link") or "").strip() or None
        text_ms = (row.get("fulltext_ms") or "").strip()
        try:
            seq = float(row.get("sequence") or 0)
        except (ValueError, TypeError):
            seq = 0.0

        if image_url:
            if image_url not in by_url:
                by_url[image_url] = {
                    "folio_label": folio_label,
                    "image_url": image_url,
                    "text_pool": [],
                }
            if text_ms:
                by_url[image_url]["text_pool"].append((seq, text_ms))
        else:
            if folio_label not in by_label:
                by_label[folio_label] = {
                    "folio_label": folio_label,
                    "image_url": None,
                    "text_pool": [],
                }
            if text_ms:
                by_label[folio_label]["text_pool"].append((seq, text_ms))

    def _finalise(entry: dict) -> dict:
        entry["text_pool"] = [
            t for _, t in sorted(entry["text_pool"], key=lambda x: x[0])
        ]
        return entry

    # Merge: url-keyed entries win; re-key everything by folio_label
    result: dict[str, dict] = {}
    for entry in by_url.values():
        label = entry["folio_label"]
        if label in result:
            suffix = 2
            while f"{label}_{suffix}" in result:
                suffix += 1
            label = f"{label}_{suffix}"
        result[label] = _finalise(entry)

    for label, entry in by_label.items():
        if label not in result:
            result[label] = _finalise(entry)

    return result
