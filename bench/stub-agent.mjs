#!/usr/bin/env node
/**
 * A stub "agent" for `bench/run.mjs` tests and CI.
 *
 * It does not think. It writes the claim named by `DT_STUB_CLAIM_<ARM>` (or
 * `DT_STUB_CLAIM`) to `$DT_OUT`, so the runner's env contract and scoring can be
 * exercised without a model. It is never used in a real run.
 *
 *   DT_STUB_CLAIM_B="src/app.py:41"   the claim arm B writes
 *   DT_STUB_NONE=1                    write no claim at all (an abstention)
 *   DT_STUB_REPORTABLE=0              claim but do not report it
 *   DT_STUB_TOKENS=123                a token count for C4
 */
import { writeFileSync } from "node:fs";

if (process.env.DT_STUB_NONE === "1") process.exit(0);

const arm = process.env.DT_ARM ?? "A";
const claim = process.env[`DT_STUB_CLAIM_${arm}`] ?? process.env.DT_STUB_CLAIM ?? "";
if (!claim) process.exit(0);
const [file, line] = claim.split(":");

writeFileSync(
  process.env.DT_OUT,
  JSON.stringify({
    file,
    line: Number(line),
    cause: "stub agent claim",
    reportable: process.env.DT_STUB_REPORTABLE !== "0",
    abstained: process.env.DT_STUB_ABSTAIN === "1",
    tokens: Number(process.env.DT_STUB_TOKENS ?? 10),
  }),
);
