"""End-to-end `rcqmap annotate` with a fake provider (no network): records, manifest, resume and bundle."""
import hashlib
import json
from pathlib import Path

from rcqmap import cli
from rcqmap.prompting import PAPER_PROMPT_SHA256
from rcqmap.providers import ProviderCompletion

ROOT = Path(__file__).resolve().parents[1]
LABELS = {json.loads(l)["query_id"]: json.loads(l)["annotation"]
          for l in (ROOT / "examples" / "labels.jsonl").read_text().splitlines() if l.strip()}


class FakeProvider:
    def __init__(self):
        self.calls = 0

    async def complete(self, *, model, system_prompt, query, schema, max_tokens, temperature):
        self.calls += 1
        assert hashlib.sha256(system_prompt.encode("utf-8")).hexdigest() == PAPER_PROMPT_SHA256
        return ProviderCompletion(text=json.dumps(LABELS[query.query_id]), response_id="r", response_model=model,
                                  finish_reason="completed", prompt_tokens=10, completion_tokens=5, total_tokens=15)


def test_annotate_resume_and_bundle(tmp_path, monkeypatch):
    fake = FakeProvider()
    monkeypatch.setattr(cli, "build_provider", lambda args: fake)
    out = tmp_path / "labels.jsonl"
    argv = ["annotate", "--input", str(ROOT / "examples" / "queries.csv"), "--output", str(out)]
    assert cli.main(argv) == 0
    records = [json.loads(l) for l in out.read_text().splitlines()]
    assert len(records) == 7 and all(r["status"] == "ok" for r in records)
    assert all("question" not in r for r in records)
    manifest = json.loads(out.with_name(out.name + ".manifest.json").read_text())
    assert manifest["paper_configuration"] is True
    assert manifest["user_message_template"] == "Question:  <query text>"
    assert cli.main(argv) == 0 and fake.calls == 7          # resume: nothing re-run
    assert cli.main(["bundle", "--output", str(out)]) == 0
    bundle = json.loads((tmp_path / "labels.import.json").read_text())
    assert len(bundle["predictions"]) == 7
