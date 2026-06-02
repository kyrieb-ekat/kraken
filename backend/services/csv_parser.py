import csv
import io
from collections import defaultdict


def parse_cantus_csv(content: bytes) -> dict[str, dict]:
    """
    Parse a Cantus Database CSV export.
    Returns a dict keyed by folio_label:
      {
        folio_label: {
          image_url: str | None,
          text_pool: [fulltext_ms, ...]   # one entry per chant row on this folio
        }
      }
    Multiple rows with the same (folio, image_link) are aggregated.
    Folios are deduplicated by image_link when it is present.
    """
    text = content.decode("utf-8-sig")  # handle BOM if present
    reader = csv.DictReader(io.StringIO(text))

    # primary key: image_url (deduplicates same page referenced by different folio labels)
    # fallback key: folio label alone when no image_url
    by_url: dict[str, dict] = {}       # image_url -> folio dict
    by_label: dict[str, dict] = {}     # folio_label -> folio dict (no-url rows)

    for row in reader:
        folio_label = (row.get("folio") or "").strip()
        image_url = (row.get("image_link") or "").strip() or None
        text_ms = (row.get("fulltext_ms") or "").strip()

        if image_url:
            if image_url not in by_url:
                by_url[image_url] = {
                    "folio_label": folio_label,
                    "image_url": image_url,
                    "text_pool": [],
                }
            if text_ms:
                by_url[image_url]["text_pool"].append(text_ms)
        else:
            if folio_label not in by_label:
                by_label[folio_label] = {
                    "folio_label": folio_label,
                    "image_url": None,
                    "text_pool": [],
                }
            if text_ms:
                by_label[folio_label]["text_pool"].append(text_ms)

    # Merge: url-keyed entries win; re-key everything by folio_label
    result: dict[str, dict] = {}
    for entry in by_url.values():
        label = entry["folio_label"]
        if label in result:
            # two different URLs share the same folio label — keep both as separate entries
            # disambiguate with a suffix
            suffix = 2
            while f"{label}_{suffix}" in result:
                suffix += 1
            label = f"{label}_{suffix}"
        result[label] = entry

    for label, entry in by_label.items():
        if label not in result:
            result[label] = entry

    return result
