# Isomer Specification

Version: 0.1 (draft). The observation contract is the stable part; treat everything under
"Detox" and "Grading" as a proposal until P2 lands.

---

## 1. The Observation

An observation is a single captured request/response pair, executed against both systems,
stored as an immutable artifact. It is the only thing the grader consumes.

```json
{
  "observationVersion": "1.0",
  "id": "obs_01J...",
  "capturedAt": "2026-11-20T10:10:55Z",
  "meta": {
    "traceId": "…",
    "replayMode": "fixture",
    "importer": "har@1.2",
    "source": "checkout-web"
  },
  "request": {
    "method": "GET",
    "path": "/api/orders",
    "query": { "status": ["open"], "page": ["2"] },
    "headers": { "accept": ["application/json"] },
    "body": null,
    "idempotencyKey": null
  },
  "legacy": { "status": 200, "headers": {}, "body": {}, "writeSet": [] },
  "shadow": { "status": 200, "headers": {}, "body": {}, "writeSet": [] }
}
```

### 1.1 Bodies are stored raw

```json
{ "mediaType": "application/json", "encoding": "utf8", "text": "{\"id\":\"1234…\"}" }
```

`text` always holds the **original bytes**, encoded per `encoding`. The grader parses a
copy. Normalization never mutates the stored artifact — this is what makes a diff
reproducible and what lets a report show the value that was normalized away.

Binary payloads use `encoding: "base64"`.

### 1.2 Numbers are a correctness hazard

JSON numbers in JavaScript are IEEE-754 doubles. Legacy systems routinely use 64-bit
identifiers and `DECIMAL(18,2)` money. Parsing those as numbers silently corrupts the
oracle before the comparison begins.

Therefore, in the canonical observation:

- 64-bit / snowflake identifiers are **strings** matching `^-?[0-9]{1,20}$`.
- Money is a **string** matching `^-?[0-9]+\.[0-9]{2}$` in minor-unit-explicit form.
- Any other number must be exactly representable as a double. Values outside that range
  must be converted to strings by the importer and declared in `meta.numericPolicy`.

This also satisfies RFC 8785 (JCS), which requires numbers to be double-representable
before canonicalization.

### 1.3 `write_set` — state as a per-request oracle

State comparison is scoped to the rows a request actually touched. Whole-database diffing
is not supported as a primary mechanism: it cannot attribute a difference to a request.

```json
{ "table": "orders", "pk": { "id": "1234" }, "op": "update",
  "patch": { "status": { "before": "new", "after": "paid" } } }
```

| `op` | required payload |
|---|---|
| `insert` | `fullRow` |
| `update` | `patch` — **only changed fields**, each `{before, after}` |
| `delete` | `fullRow` or `null` |

`update` records changed fields only, so untouched-column drift (timestamps written by
other workers, replica lag) cannot pollute the verdict.

`write_set` is optional. Without it the observation yields `response-parity` only.

---

## 2. Detox — normalization rules

Rules are **data**, addressed by JSON Pointer (RFC 6901), and applied by field, not by
endpoint. One ruleset serves every endpoint that shares a field name.

```yaml
version: 1
rules:
  - pointer: "/items/*/id"
    op: uuid
  - pointer: "/createdAt"
    op: instant            # accept ± 2s of clock skew
    params: { tolerance: "2s" }
  - pointer: "/items"
    op: unordered
    params: { sortKey: "/sku" }
  - pointer: "/amount"
    op: decimal
    params: { scale: 2 }
  - match: { method: "POST", path: "/api/sessions" }
    pointer: "/token"
    op: opaque
```

Built-in ops for v1: `uuid`, `instant`, `float`, `decimal`, `unordered`, `opaque`
(any non-empty value), `drop` (remove), `nil-if-empty`, `etag`, `pagination-cursor`.

### 2.1 Two hard rules

1. **Never write a per-endpoint normalizer.** The real scale is ~200 endpoints times a
   dozen fields; field-addressed rules are the only thing that survives it.
2. **Every ruleset is regression-tested against the corpus in both directions.** A ruleset
   tested only on "should be equal" pairs degenerates into `ignore-everything` — a perfect
   false-negative rate. The corpus must contain pairs that are genuinely different but
   superficially similar (changed rounding, changed tiebreaker, missing page item).

---

## 3. Grading

Three verdicts, ordered by severity. A report is only useful if the severities are stable.

| Verdict | Meaning | Blocks cutover |
|---|---|---|
| `exact-mismatch` | Identical after canonicalization; differs only in bytes | no |
| `normalized-mismatch` | Differs only on fields a detox rule matched | no, but reported |
| `semantic-mismatch` | Differs on a field no rule was allowed to touch | **yes** |

Every `semantic-mismatch` entry carries:

- the pointer path of each differing field, sorted stably,
- `legacy` / `shadow` values,
- **the pre-normalization values**, if a rule touched a parent object,
- the observation `id`, so the case is one command away from reproduction.

### 3.1 Determinism requirements

- Field path ordering is canonical (RFC 8785 JCS for objects; explicit sort key for arrays).
- Diff output contains no timestamps, no durations, no random ids. A snapshot test must be
  byte-stable across runs.
- The grader is a pure function of `(observation, ruleset)`.

### 3.2 Acceptance gate for P2

Against a hand-labelled corpus:

- 0 false alarms on the "non-deterministic but equal" set,
- ≥ 95% recall on the "genuinely changed" set,
- every reported diff reproducible from its stored observation.

---

## 4. Importer contract (HAR 1.2)

An importer compiles a foreign format into observations. It never reaches the grader.

- Preserve unknown fields verbatim. Exporters add private keys (`_resourceType`,
  `_webSocketMessages`, `_securityState`); dropping them loses information before
  normalization even starts.
- Body encoding in HAR is notoriously inconsistent (`encoding: base64`, mixed charsets,
  omitted content when cached). Fail loudly with the entry index, never silently emit an
  empty body.
- A HAR file yields one observation per entry; the legacy side comes from the recording,
  the shadow side is produced by replay. A single-sided observation is invalid for grading.

---

## 5. Non-goals for v1

- gRPC / protobuf bodies.
- Whole-database state diffing.
- Frontend / visual parity.
- Automatic schema migration or dual-write orchestration.
- Determining *why* a request diverged (that is a debugging tool, not a parity oracle).

---

## 6. Invariants

1. Observations are append-only; rewriting one is a bug.
2. Rules cannot mutate observations, only annotate the compared view.
3. A verdict is reproducible from `(observation, rulesetVersion)` alone.
4. Nothing in the grader knows about the network.