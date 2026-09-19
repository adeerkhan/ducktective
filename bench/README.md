# bench/ — the comparative benchmark (scaffold)

This is the capture path for design §4: compare a bare host agent (arm A) with the
same agent plus Ducktective (arm B) on a corpus of bugs with known answers, and report
**C1–C12**. C1–C7 are design v2's metrics; **C8** (blind-checker overturn rate) and
**C9** (why/evidence consistency) are design v3's; C10–C12 are the receipt ladder's. The
headline metric is **C2, the false-confirm rate**: how often an arm emits a reportable
cause that misses every gold bug-fix hunk.

> **What exists today.** One declared source (`local`), strict input validation,
> content-addressed job identity, instance validation, and the C1–C12 arithmetic, all
> tested in `smoke.test.mjs`. **What does not exist:** the Docker/corpus materialiser,
> the host-agent arm runner, and any real result — so there is no report table yet. A
> corpus source is declared **together with its materialiser**, never before it, so
> `validateInputs` cannot accept inputs nothing can fetch. Do not report a number from
> here as measured.

## Files

| File             | Role                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `sources.mjs`    | Declared corpus sources, strict input validation, content-addressed `jobId`, instance schema |
| `report.mjs`     | C1–C12 arithmetic from result rows (`rate`, `computeMetrics`)                                |
| `smoke.test.mjs` | Proves the above with no network and no model                                                |

## Instance spec

The narrow task from design §4 — a location and a one-line cause, not a patch:

```json
{
  "id": "local-demo-1",
  "source": "local",
  "repo": "/path/to/buggy/checkout",
  "commit": "<buggy-sha>",
  "repro": { "command": "python -m pytest -q tests/test_x.py::test_y" },
  "expect": { "goldHunks": [{ "file": "src/app.py", "start": 120, "end": 128 }] }
}
```

## Result row

One row per instance × arm; see the header of `report.mjs` for every field. Cost,
receipts, and cause identity all live on the row so C4–C12 are computed, not
transcribed.

## Run

```bash
npm test        # the smoke tests, including bench/*.test.mjs
```

The arm runner (`bench/run.mjs`) and the corpus materialiser are Phase 1 of
[../docs/implementation.md](../docs/implementation.md). They shell out to a host
agent CLI rather than embedding a runtime, so Ducktective stays a skill.
