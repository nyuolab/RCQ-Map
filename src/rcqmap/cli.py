"""Command-line interface.

    rcqmap annotate --input queries.csv --output labels.jsonl          # paper configuration by default
    rcqmap annotate ... --dry-run                                      # plan only, no API calls
    rcqmap derive   --input labels.jsonl --output reported.csv         # the 20 fields reported in the paper
    rcqmap compare  --input labels.jsonl                               # your task mix against the paper's RCQs
    rcqmap verify                                                       # check guideline and schema checksums

API keys are read from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, or RCQMAP_COMPAT_API_KEY with
RCQMAP_COMPAT_BASE_URL for an OpenAI-compatible server). A .env file in the working directory is read if
python-dotenv is installed. Never commit keys.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path

from . import __version__
from .batch import BatchConfig, run_batch
from .dataset import Query, file_sha256, load_queries
from .derive import derive
from collections import Counter
from .prompting import (PAPER_PROMPT_SHA256, default_prompt_path, default_schema_path, load_system_prompt,
                        plan_concurrency)
from .providers import (AnthropicProvider, OpenAICompatibleProvider, OpenAIResponsesHTTPClient,
                        OpenAIResponsesProvider)
from .schema import AnnotationSchema
from .storage import OutputStore

PAPER = {"provider": "openai", "model": "gpt-5.6-sol", "reasoning_effort": "none", "max_tokens": 1200}
DEFAULT_MODELS = {"openai": "gpt-5.6-sol", "anthropic": "claude-sonnet-5-5", "compatible": ""}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(Path.cwd() / ".env", override=False)


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is not set. Export it or put it in a local .env file (never commit it).")
    return value


def build_provider(args: argparse.Namespace):
    if args.provider == "openai":
        client = OpenAIResponsesHTTPClient(api_key=_require("OPENAI_API_KEY"), timeout=args.timeout)
        return OpenAIResponsesProvider(client, reasoning_effort=args.reasoning_effort)
    if args.provider == "anthropic":
        try:
            import anthropic
        except ImportError as error:
            raise SystemExit("Install the Anthropic SDK: pip install 'rcqmap[anthropic]'") from error
        return AnthropicProvider(anthropic.AsyncAnthropic(api_key=_require("ANTHROPIC_API_KEY"), timeout=args.timeout))
    if args.provider == "compatible":
        try:
            import openai
        except ImportError as error:
            raise SystemExit("Install the OpenAI SDK: pip install 'rcqmap[compatible]'") from error
        client = openai.AsyncOpenAI(base_url=_require("RCQMAP_COMPAT_BASE_URL"),
                                    api_key=os.environ.get("RCQMAP_COMPAT_API_KEY", "none"), timeout=args.timeout)
        return OpenAICompatibleProvider(client, json_mode=args.json_mode)
    raise SystemExit(f"Unknown provider {args.provider!r}")


def _select(queries: list[Query], limit: int | None) -> list[Query]:
    return queries[:limit] if limit else queries


def _query_file(args: argparse.Namespace) -> Path:
    """Write a two-column view (id, query) when --text-column/--id-column are given, so dataset.load_queries
    finds the right columns; the temporary file sits next to the output and is removed afterwards."""
    src = args.input.expanduser().resolve()
    if not args.text_column and not args.id_column:
        return src
    with src.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    tmp = args.output.expanduser().resolve().with_suffix(".input.tmp.csv")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "query"])
        for i, r in enumerate(rows, 1):
            w.writerow([r.get(args.id_column, "") if args.id_column else f"Q{i:05d}",
                        r.get(args.text_column or "query", "")])
    return tmp


def cmd_annotate(args: argparse.Namespace) -> int:
    _load_env()
    prompt_path = (args.guidelines or default_prompt_path()).expanduser().resolve()
    schema_path = (args.schema or default_schema_path()).expanduser().resolve()
    schema = AnnotationSchema.load(schema_path)
    system_prompt, prompt_sha256 = load_system_prompt(prompt_path)
    schema.validate_prompt_coverage(system_prompt)
    if prompt_sha256 != PAPER_PROMPT_SHA256:
        print("NOTE: these guidelines differ from the version used in the paper "
              f"(sha256 {prompt_sha256[:12]}… vs {PAPER_PROMPT_SHA256[:12]}…).", file=sys.stderr)
    input_path = _query_file(args)
    try:
        selected = _select(load_queries(input_path), args.limit)
        dataset_sha256 = file_sha256(input_path)
    finally:
        if input_path != args.input.expanduser().resolve():
            input_path.unlink(missing_ok=True)

    fingerprint_input = {
        "format_version": 1, "rcqmap_version": __version__, "provider": args.provider, "model": args.model,
        "reasoning_effort": args.reasoning_effort if args.provider == "openai" else None,
        "max_tokens": args.max_tokens, "temperature": args.temperature, "prompt_sha256": prompt_sha256,
        "schema_sha256": file_sha256(schema_path), "schema_version": schema.version,
        "dataset_sha256": dataset_sha256, "selected_query_ids": [q.query_id for q in selected],
        "user_message_template": "Question:  <query text>", "include_query_text": False,
    }
    manifest = {**fingerprint_input,
                "run_fingerprint": hashlib.sha256(json.dumps(fingerprint_input, sort_keys=True).encode()).hexdigest(),
                "paper_configuration": (args.provider, args.model, args.reasoning_effort, args.max_tokens)
                == (PAPER["provider"], PAPER["model"], PAPER["reasoning_effort"], PAPER["max_tokens"])
                and prompt_sha256 == PAPER_PROMPT_SHA256,
                "created_at": utc_now(), "input_records": len(selected)}

    output_path = args.output.expanduser().resolve()
    if args.dry_run:
        plan = plan_concurrency(system_prompt, selected, max_output_tokens=args.max_tokens,
                                token_budget=args.token_budget, max_concurrency=args.max_concurrency,
                                characters_per_token=3.0)
        print(f"{len(selected)} queries; ~{plan.estimated_tokens_per_request:,} tokens per request "
              f"(~{plan.estimated_tokens_per_request * len(selected):,} in total); concurrency {plan.concurrency}.")
        print("Dry run: no API was contacted and nothing was written.")
        return 0

    provider = build_provider(args)
    with OutputStore(output_path) as store:
        manifest = store.prepare_manifest(manifest)
        done = store.successful_query_ids()
        pending = [q for q in selected if q.query_id not in done]
        if not pending:
            print("All queries already have valid annotations.")
            return 0
        plan = plan_concurrency(system_prompt, pending, max_output_tokens=args.max_tokens,
                                token_budget=args.token_budget, max_concurrency=args.max_concurrency,
                                characters_per_token=3.0)
        config = BatchConfig(provider=args.provider, model=args.model, max_tokens=args.max_tokens,
                             temperature=args.temperature, max_retries=args.max_retries,
                             include_query_text=False, prompt_sha256=prompt_sha256)
        counts = {"ok": 0, "error": 0}

        def on_result(record, completed, total):
            store.append(record)
            counts[record["status"]] = counts.get(record["status"], 0) + 1
            if completed % 25 == 0 or completed == total:
                print(f"{completed}/{total} done ({counts['ok']} valid, {counts['error']} failed)", flush=True)

        asyncio.run(run_batch(provider=provider, queries=pending, system_prompt=system_prompt, schema=schema,
                              concurrency=plan.concurrency, config=config, on_result=on_result))
        manifest["updated_at"] = utc_now()
        store.write_manifest(manifest)
    print(f"Wrote {output_path} ({counts['ok']} valid, {counts['error']} failed).")
    return 0 if counts["error"] == 0 else 1


def cmd_derive(args: argparse.Namespace) -> int:
    rows = [{"query_id": qid, **derive(a)} for qid, a in _valid_annotations(args.input).items()]
    with args.output.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows)} rows to {args.output}")
    return 0


def _valid_annotations(path: Path) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rec = json.loads(line)
                if rec.get("status") == "ok":
                    latest[str(rec["query_id"])] = rec["annotation"]
    if not latest:
        raise SystemExit("No valid annotations found.")
    return latest


def cmd_compare(args: argparse.Namespace) -> int:
    """Compare the distribution of your labels with the paper's 127,625 real clinical queries."""
    ref = json.loads(Path(str(resources.files("rcqmap") / "data" / "rcq_reference.json")).read_text(encoding="utf-8"))
    rows = [derive(a) for a in _valid_annotations(args.input).values()]
    n = len(rows)
    report: dict = {"n": n, "reference_n": ref["n"], "fields": {}}
    print(f"{n} labeled queries versus {ref['n']:,} real clinical queries (RCQs). Shares in %.")
    for title, key in [("Kind of work", "kind_of_work"), ("Task category", "task_category"),
                       ("Intent group", "intent_group"), ("Potential harm", "risk"), ("Safest response", "route")]:
        refd = ref[key]
        counts = Counter(r[key] for r in rows)
        mine = {c: counts.get(c, 0) / n for c in refd}
        covered = 1 - 0.5 * sum(abs(mine[c] - refd[c]) for c in refd)
        report["fields"][key] = {"share_of_rcq_mix": covered, "yours": mine, "rcq": refd}
        print(f"\n{title}: your items cover {covered:.0%} of the RCQ mix")
        print(f"  {'':40s} {'yours':>7s} {'RCQs':>7s}")
        for c in refd:
            print(f"  {c:40s} {100 * mine[c]:7.1f} {100 * refd[c]:7.1f}")
    print("\nBinary fields")
    print(f"  {'':40s} {'yours':>7s} {'RCQs':>7s}")
    for title, key in [("Patient-specific", "patient_specific"), ("Needs patient or local information", "ctx_local"),
                       ("High or critical potential harm", "high_or_critical"),
                       ("Cannot be answered well as posed", "answer_not_high"),
                       ("Safest response is not a direct answer", "not_direct")]:
        mine = sum(int(r[key]) for r in rows) / n
        report["fields"][key] = {"yours": mine, "rcq": ref[key]}
        print(f"  {title:40s} {100 * mine:7.1f} {100 * ref[key]:7.1f}")
    if args.json:
        args.json.write_text(json.dumps(report, indent=1), encoding="utf-8")
        print(f"\nWrote {args.json}")
    return 0


def cmd_bundle(args: argparse.Namespace) -> int:
    """Write the import bundle that the annotation platform's admin dashboard accepts (labels only, no text)."""
    out = args.output.expanduser().resolve()
    with OutputStore(out) as store:
        if not store.manifest_path.exists():
            raise SystemExit(f"No run manifest next to {out}; bundle only outputs written by `rcqmap annotate`.")
        manifest = json.loads(store.manifest_path.read_text(encoding="utf-8"))
        path = store.write_import_bundle(manifest)
    print(f"Wrote {path}")
    return 0


def cmd_verify(_: argparse.Namespace) -> int:
    sha = hashlib.sha256(default_prompt_path().read_bytes()).hexdigest()
    ok = sha == PAPER_PROMPT_SHA256
    print(f"guidelines sha256 {sha} {'(paper version)' if ok else '(DIFFERS from the paper version)'}")
    schema = AnnotationSchema.load(default_schema_path())
    print(f"schema {schema.version}, {len(schema.keys)} fields, sha256 {file_sha256(default_schema_path())}")
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="rcqmap", description="Annotate clinical queries with RCQ-Map.")
    p.add_argument("--version", action="version", version=f"rcqmap {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    a = sub.add_parser("annotate", help="annotate a CSV of queries")
    a.add_argument("--input", type=Path, required=True, help="CSV with one query per row")
    a.add_argument("--text-column", help="column holding the query text (default: auto-detect)")
    a.add_argument("--id-column", help="column holding a unique query id (default: auto-detect or row number)")
    a.add_argument("--output", type=Path, required=True, help="JSONL of labels (resumable; a manifest is written next to it)")
    a.add_argument("--provider", choices=["openai", "anthropic", "compatible"], default=PAPER["provider"])
    a.add_argument("--model", default=None, help=f"default for openai: {PAPER['model']} (the paper's annotator)")
    a.add_argument("--reasoning-effort", default=PAPER["reasoning_effort"], help="OpenAI Responses reasoning effort")
    a.add_argument("--max-tokens", type=int, default=PAPER["max_tokens"])
    a.add_argument("--temperature", type=float, default=None)
    a.add_argument("--max-retries", type=int, default=4)
    a.add_argument("--max-concurrency", type=int, default=8)
    a.add_argument("--token-budget", type=int, default=200_000, help="approximate tokens in flight")
    a.add_argument("--timeout", type=float, default=120.0)
    a.add_argument("--json-mode", action="store_true", help="request JSON mode from an OpenAI-compatible server")
    a.add_argument("--guidelines", type=Path, help="alternative guidelines file (the paper used the bundled one)")
    a.add_argument("--schema", type=Path, help="alternative schema file")
    a.add_argument("--limit", type=int, help="annotate only the first N queries")
    a.add_argument("--dry-run", action="store_true", help="estimate tokens without calling any API")
    a.set_defaults(func=cmd_annotate)

    d = sub.add_parser("derive", help="add the fields as reported in the paper")
    d.add_argument("--input", type=Path, required=True, help="labels JSONL from `rcqmap annotate`")
    d.add_argument("--output", type=Path, required=True, help="CSV of reported fields")
    d.set_defaults(func=cmd_derive)

    c = sub.add_parser("compare", help="compare your label distribution with the paper's real clinical queries")
    c.add_argument("--input", type=Path, required=True, help="labels JSONL from `rcqmap annotate`")
    c.add_argument("--json", type=Path, help="also write the comparison as JSON")
    c.set_defaults(func=cmd_compare)

    b = sub.add_parser("bundle", help="write an import bundle for the annotation platform")
    b.add_argument("--output", type=Path, required=True, help="labels JSONL written by `rcqmap annotate`")
    b.set_defaults(func=cmd_bundle)

    v = sub.add_parser("verify", help="check that the bundled guidelines are the ones used in the paper")
    v.set_defaults(func=cmd_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, "provider", None) and args.model is None:
        args.model = DEFAULT_MODELS[args.provider]
        if not args.model:
            raise SystemExit("--model is required for --provider compatible")
    return args.func(args)
