# RCQ-Map clinician annotation platform

A Next.js web application for blinded clinician annotation with RCQ-Map, as used for the paper's validation study
(three clinicians per query, forced-choice fields, the full guidelines shown inline, hard consistency rules
enforced, keyboard shortcuts). An admin dashboard shows progress, inter-rater reliability and model–clinician
concordance.

The guidelines shown to clinicians are built from `../guidelines/annotation_guidelines.txt` at build time, so
clinicians and the model see byte-identical text.

## Run locally

```bash
npm install
cp .env.example .env          # then edit; never commit .env
npm run dev                   # without DATABASE_URL, runs a browser-only demo on the invented example queries
npm test
```

Point `ANNOTATION_INPUT` at your own query CSV (columns `id`, `specialty`, `question`). Keep that file outside the
repository; `.gitignore` also blocks common query-file names. Study parameters (initial batch of 40, extra
batches of 10, three reviews per query, seed 42) are in `lib/study-config.js`.

## Importing model labels

`rcqmap bundle --output labels.jsonl` writes an import bundle that the admin dashboard accepts. The server
rejects any bundle that contains query text and stores only labels and run metadata.

## Data protection

Run this platform only inside an environment approved for the query data you use (for clinical queries, typically
an institutional deployment with appropriate agreements). Nothing in this repository contains real queries.
