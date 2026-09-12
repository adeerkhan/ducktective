import type { Candidate, CoveredSite } from "@/lib/engine/types";

export type CoverageMap = Record<string, { fail: number; pass: number }>;

type Probe = {
  name: string;
  run: (cov: CoverageMap, bucket: "fail" | "pass") => void;
};

export type Fixture = {
  id: string;
  title: string;
  repo: string;
  file: string;
  language: "javascript";
  symptom: string;
  command: string;
  source: string;
  failing: Probe;
  passing: Probe[];
  candidates: Omit<Candidate, "rank" | "verdict" | "evidence">[];
  patch?: string;
  cause: string;
};

function hit(cov: CoverageMap, id: string, bucket: "fail" | "pass") {
  const cur = cov[id] ?? { fail: 0, pass: 0 };
  cur[bucket] += 1;
  cov[id] = cur;
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    const err = new Error(`${label}\nexpected ${e}\ngot      ${a}`);
    err.name = "AssertionError";
    throw err;
  }
}

function sliceRange(
  arr: number[],
  start: number,
  end: number,
  cov: CoverageMap,
  bucket: "fail" | "pass",
) {
  hit(cov, "range:sliceRange", bucket);
  const out: number[] = [];
  for (let i = start; i <= end; i++) {
    hit(cov, "range:loop", bucket);
    if (i >= 0 && i < arr.length) {
      hit(cov, "range:push", bucket);
      out.push(arr[i]!);
    }
  }
  return out;
}

function sum(arr: number[], cov: CoverageMap, bucket: "fail" | "pass") {
  hit(cov, "range:sum", bucket);
  return arr.reduce((a, b) => a + b, 0);
}

const cacheStore: Record<string, number[]> = {};

function loadOrders(userId: string): number[] {
  return userId === "ada" ? [11, 22] : [7];
}

function getOrders(userId: string, cov: CoverageMap, bucket: "fail" | "pass") {
  hit(cov, "cache:getOrders", bucket);
  if (!cacheStore[userId]) {
    hit(cov, "cache:miss", bucket);
    cacheStore[userId] = loadOrders(userId);
  } else {
    hit(cov, "cache:hit", bucket);
  }
  return cacheStore[userId]!;
}

function canAccess(
  user: { admin: boolean },
  resource: { public: boolean },
  cov: CoverageMap,
  bucket: "fail" | "pass",
) {
  hit(cov, "access:canAccess", bucket);
  if (user.admin) hit(cov, "access:admin", bucket);
  if (resource.public) hit(cov, "access:public", bucket);
  return user.admin && resource.public;
}

function isSameLocalDay(
  isoUtc: string,
  localYmd: string,
  cov: CoverageMap,
  bucket: "fail" | "pass",
) {
  hit(cov, "dates:isSameLocalDay", bucket);
  const slice = isoUtc.slice(0, 10);
  hit(cov, "dates:slice", bucket);
  return slice === localYmd;
}

function formatCents(cents: number, cov: CoverageMap, bucket: "fail" | "pass") {
  hit(cov, "money:formatCents", bucket);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  hit(cov, "money:pad", bucket);
  return `${neg ? "-" : ""}$${dollars}.${rest}`;
}

export const FIXTURES: Fixture[] = [
  {
    id: "inclusive-end",
    title: "sliceRange returns an extra element",
    repo: "tiny-range",
    file: "lib/range.js",
    language: "javascript",
    symptom:
      "test_slice_middle failed: sliceRange([10,20,30,40], 1, 3) should be [20,30] (Python-style exclusive end) but returned [20,30,40].",
    command: "node --test test/range.test.js",
    source: `export function sliceRange(arr, start, end) {
  const out = []
  for (let i = start; i <= end; i++) {
    if (i >= 0 && i < arr.length) out.push(arr[i])
  }
  return out
}

export function sum(arr) {
  return arr.reduce((a, b) => a + b, 0)
}`,
    failing: {
      name: "test_slice_middle",
      run: (cov, bucket) => {
        const got = sliceRange([10, 20, 30, 40], 1, 3, cov, bucket);
        assertEqual(got, [20, 30], "test_slice_middle");
      },
    },
    passing: [
      {
        name: "test_sum",
        run: (cov, bucket) => {
          assertEqual(sum([1, 2, 3], cov, bucket), 6, "test_sum");
        },
      },
    ],
    candidates: [
      {
        id: "mut",
        location: "sliceRange · lib/range.js:2",
        why: "On the failing stack, and the extra value looks like the input was mutated.",
        hypothesis: "sliceRange mutates the input array, so later assertions see leftover values.",
        checkName: "input identity oracle",
        checkSource: `const src = [10, 20, 30, 40]
const copy = src.slice()
sliceRange(src, 1, 3)
assert.deepEqual(src, copy)`,
      },
      {
        id: "inc",
        location: "sliceRange loop · lib/range.js:3",
        why: "Fail-only coverage: the loop body is hit only by the failing test. Exclusive-end callers would stop one iteration earlier.",
        hypothesis:
          "The loop uses `i <= end` (inclusive). Python-style sliceRange must treat `end` as exclusive, so the call with end=3 yields one extra element.",
        checkName: "exclusive-end oracle",
        checkSource: `assert.deepEqual(
  sliceRange([10, 20, 30, 40], 1, 3),
  [20, 30]
)`,
      },
    ],
    patch: `for (let i = start; i < end; i++) {`,
    cause:
      "sliceRange's loop is inclusive of `end`. The test (and the documented Python-style contract) requires an exclusive end.",
  },
  {
    id: "leaky-cache",
    title: "getOrders leaks a mutable cache row",
    repo: "shop-cache",
    file: "lib/orders.js",
    language: "javascript",
    symptom:
      "After a caller sorts the result of getOrders('ada'), a later getOrders('ada') returns the sorted array. Tests expected the original load order [11, 22].",
    command: "node --test test/orders.test.js",
    source: `const cache = {}

function loadOrders(userId) {
  return userId === "ada" ? [11, 22] : [7]
}

export function getOrders(userId) {
  if (!cache[userId]) cache[userId] = loadOrders(userId)
  return cache[userId]
}`,
    failing: {
      name: "test_cache_isolation",
      run: (cov, bucket) => {
        for (const key of Object.keys(cacheStore)) delete cacheStore[key];
        const first = getOrders("ada", cov, bucket);
        first.sort((a, b) => b - a);
        const second = getOrders("ada", cov, bucket);
        assertEqual(second, [11, 22], "test_cache_isolation");
      },
    },
    passing: [
      {
        name: "test_fresh_load",
        run: (cov, bucket) => {
          for (const key of Object.keys(cacheStore)) delete cacheStore[key];
          assertEqual(getOrders("ada", cov, bucket), [11, 22], "test_fresh_load");
        },
      },
    ],
    candidates: [
      {
        id: "load",
        location: "loadOrders · lib/orders.js:4",
        why: "The wrong numbers have to come from somewhere; loadOrders is the producer.",
        hypothesis:
          "loadOrders returns pre-sorted data for ada, so the test's expected [11, 22] is simply wrong.",
        checkName: "fresh-load oracle",
        checkSource: `delete cache.ada
assert.deepEqual(getOrders("ada"), [11, 22])`,
      },
      {
        id: "ref",
        location: "getOrders return · lib/orders.js:9",
        why: "Failing run hits the cache-hit path after a caller mutated the previous return value. Passing run never mutates.",
        hypothesis:
          "getOrders returns the cached array by reference. Callers can mutate the store, so later reads see the mutation.",
        checkName: "reference-identity oracle",
        checkSource: `delete cache.ada
const a = getOrders("ada")
const b = getOrders("ada")
assert.notEqual(a, b) // copies should not be the same reference
assert.deepEqual(b, [11, 22])`,
      },
    ],
    patch: `return cache[userId].slice()`,
    cause:
      "getOrders returns the cached array by reference. A caller sorted it in place, poisoning later reads.",
  },
  {
    id: "admin-and",
    title: "Public resources require admin",
    repo: "acl-lite",
    file: "lib/access.js",
    language: "javascript",
    symptom:
      "Guest users cannot open public docs. canAccess({admin:false}, {public:true}) returns false; the contract says public resources are world-readable.",
    command: "node --test test/access.test.js",
    source: `export function canAccess(user, resource) {
  return user.admin && resource.public
}`,
    failing: {
      name: "test_public_guest",
      run: (cov, bucket) => {
        const ok = canAccess({ admin: false }, { public: true }, cov, bucket);
        assertEqual(ok, true, "test_public_guest");
      },
    },
    passing: [
      {
        name: "test_admin_private",
        run: (cov, bucket) => {
          const ok = canAccess({ admin: true }, { public: false }, cov, bucket);
          assertEqual(ok, false, "test_admin_private");
        },
      },
    ],
    candidates: [
      {
        id: "flag",
        location: "resource.public · lib/access.js:2",
        why: "The failing test is about a public flag; maybe the fixture set it wrong.",
        hypothesis:
          "The resource in the failing test is not actually marked public, so deny is correct.",
        checkName: "public-flag oracle",
        checkSource: `const resource = { public: true }
assert.equal(resource.public, true)
assert.equal(canAccess({ admin: false }, resource), true)`,
      },
      {
        id: "op",
        location: "canAccess operator · lib/access.js:2",
        why: "Fail-only path: guest + public. The passing test is admin + private and uses the same operator, but that case is false either way.",
        hypothesis:
          "The predicate uses `&&` so a resource must be both admin-owned and public. Public-to-guest should be `user.admin || resource.public`.",
        checkName: "guest-public oracle",
        checkSource: `assert.equal(
  canAccess({ admin: false }, { public: true }),
  true
)`,
      },
    ],
    patch: `return user.admin || resource.public`,
    cause:
      "canAccess uses `&&` instead of `||`, so public resources still require admin. Guests are denied.",
  },
  {
    id: "utc-day",
    title: "isSameLocalDay compares UTC dates",
    repo: "calendar-core",
    file: "lib/dates.js",
    language: "javascript",
    symptom:
      "A meeting at 2026-09-12T02:30:00.000Z (evening of Sep 11 in US Pacific) is classified as Sep 12. The product asked for the user's local calendar day.",
    command: "node --test test/dates.test.js",
    source: `export function isSameLocalDay(isoUtc, localYmd) {
  return isoUtc.slice(0, 10) === localYmd
}`,
    failing: {
      name: "test_pacific_evening",
      run: (cov, bucket) => {
        const iso = "2026-09-12T02:30:00.000Z";
        const local = "2026-09-11";
        assertEqual(isSameLocalDay(iso, local, cov, bucket), true, "test_pacific_evening");
      },
    },
    passing: [
      {
        name: "test_noon_utc",
        run: (cov, bucket) => {
          const iso = "2026-09-12T12:00:00.000Z";
          assertEqual(isSameLocalDay(iso, "2026-09-12", cov, bucket), true, "test_noon_utc");
        },
      },
    ],
    candidates: [
      {
        id: "tz",
        location: "caller localYmd · test/dates.test.js",
        why: "The test name mentions Pacific; maybe the expected day is simply wrong.",
        hypothesis:
          "The test's expected local day is off by one. The UTC date is the intended calendar day.",
        checkName: "product-contract oracle",
        checkSource: `// Product: compare against the user's local Y-M-D, not the UTC prefix.
assert.equal(
  isSameLocalDay("2026-09-12T02:30:00.000Z", "2026-09-11"),
  true
)`,
      },
      {
        id: "slice",
        location: "isoUtc.slice(0, 10) · lib/dates.js:2",
        why: "Fail-only: the UTC prefix is 2026-09-12 while the asserted local day is 2026-09-11. Passing noon-UTC case cannot expose the shift.",
        hypothesis:
          "isSameLocalDay uses the UTC YYYY-MM-DD prefix. Instants near midnight UTC belong to the previous local day in US timezones.",
        checkName: "utc-prefix mismatch",
        checkSource: `const iso = "2026-09-12T02:30:00.000Z"
assert.notEqual(iso.slice(0, 10), "2026-09-11")
assert.equal(isSameLocalDay(iso, "2026-09-11"), true)`,
      },
    ],
    patch: `const local = new Date(isoUtc)
const y = local.getFullYear()
const m = String(local.getMonth() + 1).padStart(2, "0")
const d = String(local.getDate()).padStart(2, "0")
return \`\${y}-\${m}-\${d}\` === localYmd`,
    cause:
      "isSameLocalDay slices the UTC string. Near-midnight UTC instants land on the next calendar day in US timezones.",
  },
  {
    id: "already-shipped",
    title: "formatCents already matches the ticket",
    repo: "ledger-print",
    file: "lib/money.js",
    language: "javascript",
    symptom:
      "Ticket says formatCents(1250) prints 12.50 without a leading dollar sign. A later patch may already have landed. Confirm before touching it.",
    command: "node --test test/money.test.js",
    source: `export function formatCents(cents) {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rest = String(abs % 100).padStart(2, "0")
  return \`\${neg ? "-" : ""}$\${dollars}.\${rest}\`
}`,
    failing: {
      name: "test_format_1250",
      run: (cov, bucket) => {
        assertEqual(formatCents(1250, cov, bucket), "$12.50", "test_format_1250");
      },
    },
    passing: [],
    candidates: [],
    cause: "The current implementation already satisfies the live test. The ticket is stale.",
  },
];

export function getFixture(id: string): Fixture | undefined {
  return FIXTURES.find((f) => f.id === id);
}

export function sitesFromCoverage(file: string, cov: CoverageMap): CoveredSite[] {
  return Object.entries(cov).map(([id, hits]) => ({
    id,
    file,
    label: id,
    failHits: hits.fail,
    passHits: hits.pass,
  }));
}
