"""Prepare clinician validation labels for sharing.

Reads the annotation platform's export (one row per rater x query) and writes a CSV that keeps only the
query id, a pseudonymous rater id and the 24 RCQ-Map fields. Query text, notes, rater names, timestamps and
dataset identifiers are dropped. Rater ids are replaced by salted hashes; keep the salt private.

    python export_validation_labels.py --input platform_export.csv --output validation_labels.csv --salt-env RCQMAP_SALT

Do not publish the output until your institution has approved release of validation-set labels.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIELDS = [f["key"] for f in json.loads((HERE.parent / "schema" / "annotation_schema.json").read_text())["fields"]]
DROP = {"question", "query", "query_text", "notes", "rater_name", "created_at", "updated_at", "dataset_id", "specialty"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--salt-env", default="RCQMAP_SALT", help="environment variable holding a private salt")
    args = ap.parse_args()
    salt = os.environ.get(args.salt_env, "")
    if len(salt) < 16:
        raise SystemExit(f"Set {args.salt_env} to a private random string of at least 16 characters.")
    with args.input.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    missing = [f for f in FIELDS + ["rater_id", "question_id"] if f not in rows[0]]
    if missing:
        raise SystemExit(f"Input is missing columns: {missing}")
    out = []
    for r in rows:
        if str(r.get("is_complete", "true")).lower() in {"false", "0"}:
            continue
        pseudo = "R" + hashlib.sha256((salt + r["rater_id"]).encode()).hexdigest()[:10]
        out.append({"question_id": r["question_id"], "rater": pseudo, **{f: r[f] for f in FIELDS}})
    with args.output.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["question_id", "rater"] + FIELDS)
        w.writeheader()
        w.writerows(out)
    print(f"Wrote {len(out)} rows (dropped columns: {sorted(DROP & set(rows[0]))}).")


if __name__ == "__main__":
    main()
