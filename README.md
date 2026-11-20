# Isomer

**Prove your rewrite is the same product.**

Isomer turns the strangler-fig migration into a verifiable pipeline. Every production
request becomes a recorded, reproducible piece of evidence that the legacy system and the
rewrite return the same answer — and leave the same state behind.

> **Status: design stage.** This repository currently contains a specification and a JSON
> Schema. The CLI is not implemented yet, and no roadmap phase has been merged. See
> [Roadmap](#roadmap) and [How this is built](#how-this-is-built).

## The problem

Rewrites fail on behaviour, not on architecture. The decision to cut over is usually made
on unit tests and a manual QA pass — neither of which covers the long tail of real
production traffic. So teams ship, and then discover the tail in production.

The alternative — a full parallel run with a database diff — is worse: by the time you
have a working dual-write you have already performed the migration, and any disagreement
is unattributable because the two datasets have drifted independently.

Isomer takes the third path: **compare responses per request, and use state only as a
per-request oracle.** A diff you cannot attribute to a request is not evidence, it is noise.

## Design principles

1. **The observation is immutable; the diff is pure.** A diff that cannot be reproduced
   from a stored artifact is not a diff. Store the observation, recompute the verdict.
2. **Rules are data, not code.** Normalization rules are edited hundreds of times. They
   live in reviewable configuration keyed by JSON Pointer, hot-reloadable, and covered by
   the golden corpus.
3. **Build the ruler before the measurement.** The normalization and grading engine is
   validated against fixture pairs with hand-assigned ground truth *before* it ever sees
   live traffic. Noise you cannot classify is not a finding.

## Pipeline

```
edge logs ──▶ corpus selection ──▶ replayer ──┬──▶ legacy
                                              └──▶ shadow
                                                    │
                    observation (immutable) ────────┘
                              │
                              ▼
                     detox (rules) ──▶ diff grade ──▶ parity report
```

Only the *observation* contract is stable across all of these. Importers compile to it;
the grader consumes nothing else.

## Scope of v1

| Input | v1 | Notes |
|---|---|---|
| **HAR 1.2** | supported importer | Single file, self-contained bodies, exportable from any browser devtools. |
| **Canonical NDJSON observation** | the internal format | The only format the grader understands. HAR is just one compiler into it. |
| **Envoy / gateway access logs** | corpus mining only | Access logs do **not** contain bodies by default; they are used to select which endpoints to verify, never to compare bodies. |
| **gRPC / protobuf** | out of scope | Field-level normalization needs descriptors; byte comparison is not parity. |

Two levels of assertion:

- `response-parity` — requires only bodies (HAR is enough).
- `state-parity` — additionally requires a `write_set` supplied by the adopter's own DB hook.

## Roadmap

| Phase | Deliverable |
|---|---|
| P0 | Observation schema + validator + fixture loader |
| P1 | Declarative detox rules + engine |
| P2 | Diff grader: exact / normalized / semantic, stable serialization |
| P3 | Golden corpus runner + CI gate |
| P4 | HAR 1.2 importer |
| P5 | Shadow traffic replayer + routed cutover and rollback |

## How this is built

This repository is built agent-first, and that constraint shaped the design rather than
the other way round.

Each phase above is scoped to a single pull request with a **machine-checkable acceptance
gate written before the code** — fixture in, verdict out, exit code decides. No phase
requires a running environment, a review comment or human judgement to be called done.

Why the spec above looks like it does:

- the observation contract exists so a grader can be built against fixtures alone, with no
  live system in the loop;
- detox rules are data so they can be iterated from a failing test, not from a hunch;
- the grading taxonomy is fixed so "done" is a number (0 false alarms, >= 95% recall)
  instead of an opinion.

**Devin** is the intended executor for P0-P5. Every phase is specified as an isolated,
deterministic task that an autonomous coding agent can implement, test against the golden
corpus and hand back unaided; [`SPEC.md`](SPEC.md) is written to serve as that brief.

The structure of the work is honest about its own state: **no phase has been merged yet.**
The design and the schema are the current artifacts, and the first merged pull request will
be P0.

## Documentation

- [`SPEC.md`](SPEC.md) — observation contract, detox rule grammar, grading taxonomy
- [`schema/observation.schema.json`](schema/observation.schema.json) — machine-readable contract

## License

Apache-2.0 (see [`LICENSE`](LICENSE)). The detox rule corpus and fixtures are intended to
be released under CC0 so that adopters can contribute the noise patterns they discover.