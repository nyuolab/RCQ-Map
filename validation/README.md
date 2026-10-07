# Validating RCQ-Map on your own queries

The paper validated the annotator on 100 randomly sampled queries, each annotated independently by three of seven
clinicians (300 annotations) with the same guidelines on the blinded platform in `../platform/`.

1. **Sample.** Draw a simple random sample of queries (the paper used 100; seed 42, Mulberry32 with a Fisher–Yates
   shuffle, as implemented in `../platform/lib/sampling.js`).
2. **Annotate.** Use the platform (three clinicians per query, assigned breadth-first) or the column template
   `clinician_annotation_template.csv`.
3. **Export without text.** `export_validation_labels.py` drops query text, notes, rater names and timestamps and
   replaces rater ids with salted hashes.
4. **Annotate the same queries with the model** (`rcqmap annotate`).
5. **Agreement.** `python agreement.py --ratings validation_labels.csv --model labels.jsonl` reports, per field,
   Krippendorff's α (ordinal for harm, answerability and safest response) with bootstrap CIs, Gwet's AC1, pairwise
   agreement, unanimity and, with `--model`, held-out-clinician and model agreement with the two-clinician
   reference. `reliability.py` holds the statistics used in the paper.

The paper's validation labels (without query text) are available from the corresponding author on request.
