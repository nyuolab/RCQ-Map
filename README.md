# RCQ-Map

RCQ-Map labels a clinical query, the request a clinician sends to an AI assistant, with the things that matter for
evaluating and deploying clinical AI: the task it asks for, the intent behind it, whether it contains the
information a safe answer needs, how much harm a wrong answer could do, and what the safest response is. It was
developed from existing frameworks in clinical-question research, LLM evaluation, patient safety and selective
prediction, validated against clinicians, and applied in the paper to 127,833 real clinical queries from one health
system and to 58 public benchmarks.

Use it to profile your own queries, a benchmark or an evaluation suite, and to see how your mix compares with
real clinical use.

## Quick start

```bash
pip install git+https://github.com/nyuolab/RCQ-Map.git     # Python 3.10 or newer, no required dependencies
export OPENAI_API_KEY=...                                   # or put it in a local .env, which git ignores

rcqmap annotate --input queries.csv --text-column query --output labels.jsonl
rcqmap derive   --input labels.jsonl --output labels.csv    # the 20 fields reported in the paper
rcqmap compare  --input labels.jsonl                        # your mix next to 127,625 real clinical queries
```

Add `--dry-run` to `annotate` for a token estimate with no API call. Runs resume where they stopped. Try it on
`examples/queries.csv` first.

## Requirements and a quick check

`rcqmap` is pure Python with no required dependencies. It is tested on macOS 26.5 (Apple silicon) with Python 3.10
and 3.14; nothing in it is platform specific. Optional extras: `python-dotenv` for `.env` files, `anthropic` 0.114
or newer for Claude, `openai` 1.55 or newer for OpenAI-compatible servers, `numpy` and `pandas` for the validation
statistics, and `pytest` for the tests. The annotation platform needs Node 20.

No special hardware is needed. The model runs at the provider; the package reads CSVs and calls an API.
Installation takes a few seconds (`pip install` finished in 3 s on a laptop, `npm ci` for the platform in 5 s). The
17 package tests run in under a second (`pip install pytest && pytest tests`), the 49 platform tests in about a
second (`cd platform && npm test`).

A demo that contacts no API:

```bash
rcqmap verify                                                               # checksums of the bundled guidelines and schema
rcqmap annotate --input examples/queries.csv --dry-run --output demo.jsonl  # token estimate, nothing written
rcqmap compare  --input examples/labels.jsonl                               # hand-written example labels against the paper's RCQs
```

The three commands finish in under a second together. `verify` prints `guidelines sha256 f8f0fc98… (paper version)`
and `schema 1.0, 24 fields`. The dry run prints `7 queries; ~13,767 tokens per request (~96,369 in total);
concurrency 7.` `compare` prints, field by field, the share of each value among the seven example labels next to
its share among the 127,625 real clinical queries, with a coverage line such as `Kind of work: your items cover 79%
of the RCQ mix`. A live run on the seven examples (drop `--dry-run`, set `OPENAI_API_KEY`) costs under ten cents. In
the paper's runs each request took about three seconds: 100 queries took 1.7 minutes at concurrency 3, and the
10,659 benchmark items took 40 minutes with `--max-concurrency 12`.

## Input and output

The input is a CSV with one query per row. Name the text column with `--text-column` and an id column with
`--id-column`; without them, both are auto-detected and ids fall back to row numbers.

`annotate` writes one JSON record per query with the 24 fields, and a manifest next to it that records the model,
settings and checksums of the guidelines, schema and input. Records never contain the query text. `derive` turns
the records into a CSV of the fields as reported in the paper. `compare` prints, field by field, your shares next
to the paper's and the share of the real task mix your items cover (one minus the total variation distance), the
same statistic the paper uses for benchmarks.

## The annotator

The default is the paper's configuration: OpenAI Responses API, `gpt-5.6-sol`, reasoning effort `none`, the
guidelines as instructions, each query as a single user message `Question:  <query text>` (two spaces), a strict
JSON schema, and at most 1,200 output tokens. Every response is checked against the schema and three consistency
rules; invalid outputs and transient errors are retried.

Other providers work too: `--provider anthropic` (Claude, JSON schema output) or `--provider compatible` for any
OpenAI-compatible server, for example a model hosted inside your institution (`RCQMAP_COMPAT_BASE_URL`). Only the
default configuration was validated against clinicians, so validate any other model on your own queries before
relying on it (see below).

**Cost.** Each request sends the guidelines (about 8,500 tokens, mostly served from the prompt cache) plus the
query, and returns about 160 tokens. Annotating the 10,659 benchmark items in the paper cost US$92.80 at list
price in October 2026, under one cent per item.

**Data protection.** Clinical queries can contain protected health information. Run the annotator only in an
environment, and with a provider, that your institution has approved for that data. The paper's corpus was
annotated by the health system's IT team in an approved environment; the investigators received labels only.

## Fields

The guidelines define 24 forced-choice fields. The paper reports 20 of them: actionability and evidence dependence
are annotated but not analyzed, patient and institutional context are combined into *needs patient or local
information*, the derived *needs any context* field is not reported, and the 12 intents are grouped into five
intent groups. `rcqmap derive` produces the reported fields.

| Block | Annotated | Reported |
|---|---|---|
| Task and domain | task category (10), question intent (12), clinical department (25), Department of Medicine division (15), AMA use case (8) | kind of work (4 groups); intent group (5) |
| Query properties | patient-specific; actionable; evidence-dependent | patient-specific |
| Context | patient; institutional; current evidence; any (derived) | patient or local information; current evidence |
| Risk | potential harm (minimal, low, moderate, high, critical) | as annotated; high or critical |
| Response | answerability (high, partial, low); safest response (direct, retrieval, clarification, escalation, abstention) | as annotated; cannot be answered well as posed; not a direct answer |
| Surface features | medication, dose, lab or result, imaging, vulnerable population, acute or urgent, text generation, query form, abbreviations | as annotated |

Clinicians agreed closely on the surface features and the task, and less on potential harm, context and the safest
response (paper, Extended Data Table 2). Read absolute prevalences of those judgment fields with that in mind;
comparisons between groups are more robust.

## Validate on your own queries

`validation/` has what the paper used: a column template for clinicians, a script that exports their labels
without query text, and the agreement statistics (Krippendorff's alpha, Gwet's AC1, held-out clinician versus
model). `platform/` is the blinded web application the clinicians annotated in. See `validation/README.md`.

## What is in the repository

| Folder | Contents |
|---|---|
| `guidelines/` | The annotation guidelines, byte-identical to the paper's runs (Supplementary Note 1) |
| `schema/` | The output schema: 24 fields and their allowed values |
| `src/rcqmap/` | The `rcqmap` command: annotate, derive, compare, bundle, verify |
| `validation/` | Clinician validation kit |
| `platform/` | Blinded clinician annotation platform (Next.js) |
| `examples/` | Invented example queries with hand-written labels |

`rcqmap verify` confirms that the bundled guidelines and schema are the ones used in the paper.

## Citation

If you use RCQ-Map, cite the paper:

Vishwanath, K. *et al.* Clinician use of language models diverges from how the models are evaluated. arXiv:2610.11069 (2026).
https://arxiv.org/abs/2610.11069

```bibtex
@misc{vishwanath2026clinician,
  title         = {Clinician use of language models diverges from how the models are evaluated},
  author        = {Vishwanath, Krithik and Lin, Haitong and Alyakin, Anton and Lee, Jin Vivian and Hewitt, D. Brock and
                   Yao, Jie J. and Small, William Robert and Khan, Hammad A. and Orillac, Cordelia and Varma, Aakaash and
                   Ye, Brandon and Alber, Daniel Alexander and Stolovitzky, Gustavo and Wiesenfeld, Batia and Nov, Oded and
                   Wu, Wei and Zhang, Kang and Aphinyanaphongs, Yindalon and Requarth, Tim and Oermann, Eric Karl and
                   {The International Digital Twin Consortium in Healthcare and Medicine}},
  year          = {2026},
  eprint        = {2610.11069},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  doi           = {10.48550/arXiv.2610.11069},
  url           = {https://arxiv.org/abs/2610.11069}
}
```

The same reference is in `CITATION.cff`, so GitHub's **Cite this repository** button exports it as BibTeX or APA. To
cite this release of the software itself, use the archived version: https://doi.org/10.5281/zenodo.23223807.

## License

Code: Apache License 2.0 (`LICENSE`). Annotation guidelines and schema: CC BY 4.0 (`LICENSE-guidelines`).
