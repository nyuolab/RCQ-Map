"""Inter-rater agreement for an RCQ-Map validation set, field by field.

Input: a long CSV with question_id, rater and the 24 fields (for example from export_validation_labels.py).
Optionally a model labels JSONL (from `rcqmap annotate`) for model-versus-clinician concordance using the
held-out-rater design of the paper (each rater in turn is held out; the reference is the label shared by the
other two when they agree).

    python agreement.py --ratings validation_labels.csv [--model labels.jsonl] [--bootstrap 2000]
"""
import argparse
import csv
import json
import random
from collections import defaultdict
from pathlib import Path

from reliability import gwet_ac1, krippendorff_alpha, observed_agreement, unanimous

HERE = Path(__file__).resolve().parent
SCHEMA = json.loads((HERE.parent / "schema" / "annotation_schema.json").read_text())
ORDINAL = {"risk": ["Minimal", "Low", "Moderate", "High", "Critical"], "answerability": ["High", "Partial", "Low"],
           "route": ["Direct", "Retrieval", "Clarification", "Escalation", "Abstention"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratings", type=Path, required=True)
    ap.add_argument("--model", type=Path)
    ap.add_argument("--bootstrap", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    by_item = defaultdict(list)
    with args.ratings.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            by_item[r["question_id"]].append(r)
    items = sorted(by_item)
    model = {}
    if args.model:
        for line in args.model.open(encoding="utf-8"):
            if line.strip():
                rec = json.loads(line)
                if rec.get("status") == "ok":
                    model[str(rec["query_id"])] = rec["annotation"]
    rng = random.Random(args.seed)
    boots = [[rng.randrange(len(items)) for _ in items] for _ in range(args.bootstrap)]
    print("field,alpha,alpha_lo,alpha_hi,ac1,pairwise,unanimous" + (",held_out_clinician_vs_ref,model_vs_ref" if model else ""))
    for f in SCHEMA["fields"]:
        key, cats = f["key"], [str(v) for v in f["allowed"]]
        M = [[str(r[key]) for r in by_item[i]] for i in items]
        level = "ordinal" if key in ORDINAL else "nominal"
        order = ORDINAL.get(key, cats)
        a = krippendorff_alpha(M, level, order=order)
        bs = sorted(krippendorff_alpha([M[j] for j in b], level, order=order) for b in boots)
        lo, hi = (bs[int(0.025 * len(bs))], bs[int(0.975 * len(bs)) - 1]) if bs else (float("nan"),) * 2
        row = [key, f"{a:.3f}", f"{lo:.3f}", f"{hi:.3f}", f"{gwet_ac1(M, cats):.3f}",
               f"{observed_agreement(M):.3f}", f"{unanimous(M):.3f}"]
        if model:
            hum = mod = n = 0
            for i, labs in zip(items, M):
                for k in range(len(labs)):
                    rest = labs[:k] + labs[k + 1:]
                    if len(set(rest)) == 1 and i in model:
                        n += 1
                        hum += labs[k] == rest[0]
                        mod += str(model[i][key]) == rest[0]
            row += [f"{hum / n:.3f}" if n else "", f"{mod / n:.3f}" if n else ""]
        print(",".join(row))


if __name__ == "__main__":
    main()
