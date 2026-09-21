# Ducktective — a guide

What it is, when to use it, and what actually happens between a failing test and a
case file. For the internals, see [architecture.md](architecture.md); for the
strategy and what is coming, [implementation.md](implementation.md).

---

## 1. The one-line pitch

**No claim without a check.**

You are a coding agent (or a person driving one). A test fails. The tempting move is
to read the traceback, notice something that looks off, and say "the bug is here."
Ducktective makes that move illegal: you must reproduce the failure, state the claim
as a hypothesis, write the smallest check that could _disprove_ it, run that check,
and let the exit code — not your confidence — decide. Only then may a case file be
written, and the writer refuses a verdict it cannot back with a receipt.

It is not a debugger, not a linter, and not a fixer. It is a prosecutor for root
causes.

---

## 2. When to reach for it

Use it when:

- a test fails and you are about to explain _why_;
- a stack trace or crash report arrives from somewhere else;
- a bug reproduces only sometimes and you need to know which kind of "sometimes";
- a regression appeared and you suspect a specific commit;
- you want a second opinion on a root cause a model already proposed.

Do **not** use it when the symptom is really a feature request, or when there is no
command that demonstrates the problem. If you cannot run something that fails, there
is nothing here to verify, and the gate will tell you so rather than invent one.

---

## 3. The shape of an investigation

```text
a failing command
   │
   ▼
reproduce ── does it fail here, on this command, with in-repo evidence?
   │              no → stop: does_not_reproduce (the ticket may be stale)
   ▼ yes
leads ── traceback frames nearest the fault, plus fail-only coverage. Max 5.
   │
   ▼
one lead at a time, in order:
   hypothesis → smallest falsifying check → run it
       │
       ├─ check agrees and a control passes or a probe flips → CONFIRMED, stop
       ├─ check holds (prediction contradicted)              → FALSIFIED, next lead
       └─ could not run / control also failed / no flip       → INCONCLUSIVE, fix or escalate
   │
   ▼
case file: JSON line + 30-second Markdown + a row in the cause index
```

Three ideas carry the whole thing:

1. **A failed command is not a reproduction unless something in _this_ repo failed.**
   A typo'd path, an uncollectable test tree, or a crash in a dependency exits
   non-zero and proves nothing about your code.
2. **Agreement is not discrimination.** A check that passes no matter what agrees
   with every hypothesis. `--control` rules out always-fail; `--probe` rules out
   always-pass by neutering the accused line and requiring the outcome to move.
3. **A verdict is arithmetic.** `predicted` plus the real exit code plus a receipt
   decides the word. No one grades their own homework.

---

## 4. A worked example

The bug: a `total()` helper drops the last row on an inclusive range.

### Step 1 — reproduce, and stop if it does not

```bash
node skills/ducktective/scripts/reproduce.mjs \
  --cmd "python -m unittest -q test_totals" \
  --symptom "totals drop the last row" \
  --out .ducktective/draft.json
```

Exit `0` means reproduced. The draft now carries the real stdout/stderr, the parsed
frames, and up to five candidate leads — nearest fault first:

```json
"candidates": [
  { "rank": 1, "location": "app.py:7 total()", "why": "appears in the failing traceback", "verdict": "pending" }
]
```

Exit `1` means the command passed; the case is `does_not_reproduce` with **zero
candidates** and the investigation stops. Exit `2` means the command never ran
properly — fix the command, not the code.

### Step 2 — state a hypothesis and run the smallest falsifying check

```bash
node skills/ducktective/scripts/run_check.mjs \
  --file .ducktective/draft.json --candidate 1 \
  --hypothesis "end defaults to len(rows)-1, so rows[end + 1] is one past the end" \
  --predict fail \
  --cmd "python -c \"from app import total; total([1, 2, 3])\"" \
  --control "python -c \"from app import total; total([1, 2, 3], 0, 1)\"" \
  --probe --yes
```

Nothing runs without `--yes`: a dry run prints the exact command and exits `3`. That
is not a sandbox — the command runs with your privileges in your repo — so the human
reads it first.

What the tool reports:

- `--predict fail` + non-zero exit → the check _agreed_.
- `--control` exiting `0` → the check can also pass somewhere, so it is not
  always-fail.
- `--probe` flipping → the check's outcome depends on the accused line.

All three → `confirmed`. `--predict fail` with exit `0` → `falsified`; demote and try
the next lead. A probe that does **not** flip → `inconclusive_vacuous`: the check was
never about that line, which is not a weaker confirmation.

### Step 3 — write the case

```bash
node skills/ducktective/scripts/write_case.mjs --file .ducktective/draft.json
```

Exit `1` is the tool working: it prints every rule the case broke. Set
`confirmed_cause`, `status: confirmed`, and the confidence the evidence supports,
then re-run. The store gains:

- `.ducktective/cases.jsonl` — one line per case id, updated in place;
- `.ducktective/cases/DT-*.md` — the human mirror;
- `.ducktective/causes.jsonl` — the cause index, where a repeated root cause
  increments `count`.

### Or do all of it in one command

```bash
node skills/ducktective/scripts/check.mjs \
  --claim "app.py:7 end defaults to len(rows)-1 and reads one past the last index" \
  --repro "python -m unittest -q test_totals" \
  --check "python -c \"from app import total; total([1, 2, 3])\"" --predict fail \
  --control "python -c \"from app import total; total([1, 2, 3], 0, 1)\"" --yes
```

`check.mjs` runs the gate, optionally bisects, runs the check with a probe, re-runs a
confirmed claim, stores the case, and prints an evidence box with a letter grade. The
letter measures **evidence completeness**, not the probability that the cause is
correct.

---

## 5. When you suspect a regression

`bisect.mjs` is the one tool that produces a fact you did not already have. It walks
first-parent history by binary search and returns the first bad commit, the hunks it
touched, and whether your accused line sits inside them.

```bash
node skills/ducktective/scripts/bisect.mjs \
  --cmd "python -m unittest -q test_totals" \
  --claim "app.py:7 total()" --budget 300 --yes
```

It measures one run first and prices the whole walk; over budget it refuses rather
than surprising you. It runs in your working tree (a scratch worktree would lack the
untracked `.venv`/`node_modules` the repro needs), so it refuses a dirty tree and
restores your branch afterwards. A bug that was always there has no green ancestor
and returns `no-good-ref` — which is a finding, not a failure.

A hunk match is supporting evidence, not proof of cause: an enabling commit can expose
an older defect.

---

## 6. Reading a case file

Open the Markdown mirror. In thirty seconds you should see: the symptom, the exact
command and outcome, the leads with their verdicts, and either a confirmed cause or
an explicitly labelled leading hypothesis. A patch, if any, is secondary and only
exists after a confirmation.

```bash
cat .ducktective/cases.jsonl        # the record, greppable
node skills/ducktective/scripts/write_case.mjs --causes   # which causes keep recurring
```

---

## 7. Limits, stated plainly

- **It does not fix.** It stops at a confirmed cause.
- **It is not a sandbox.** Approved commands run with your privileges.
- **It needs a runnable command.** Code you cannot execute is out of scope.
- **A verdict is not proof.** The store checks consistency over the records you give
  it; it cannot authenticate execution. A fabricated receipt can satisfy arithmetic.
- **A confirmed cause can still be the wrong layer.** The probe shows sensitivity to a
  line, not that the line is the root cause; `bisect` overlap is supporting evidence.
  The plan in [implementation.md](implementation.md) is how that gap closes.
- **`--verify` is a flakiness check**, not portability: same machine, same tree, fresh
  process.

---

## 8. Glossary

| Term                     | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Gate**                 | `reproduce.mjs`. Nothing downstream reasons about the bug until it exits 0.                               |
| **Lead / candidate**     | A `file:line` worth testing, seeded from frames and fail-only coverage.                                   |
| **Hypothesis**           | One sentence: what should happen under which condition, and what does not.                                |
| **Check / oracle**       | The smallest command whose result could disprove the hypothesis.                                          |
| **Control**              | A known-good path that must pass, or the check distinguishes nothing.                                     |
| **Probe**                | Neuter the accused line on a scratch worktree and re-run; no change means the check never depended on it. |
| **Receipt**              | A passing control or a flipped probe — what turns agreement into `confirmed`.                             |
| **Falsified**            | The prediction was contradicted. Demote the lead; this is a result, not a failure.                        |
| **Inconclusive**         | The check could not answer (unrunnable, timed out, control also failed).                                  |
| **Inconclusive_vacuous** | The check ran and ignored the accused line.                                                               |
| **Cause-confidence**     | Derived 0..1 rating of the recorded receipts; gates reportability.                                        |
| **Cause hash**           | Stable identity of a root cause, so a repeat is a recurrence count.                                       |
