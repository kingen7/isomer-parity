# Prototype (P0-P2, partial)

Zero dependencies, Node >= 20. This is the smallest thing that demonstrates the
three decisions in `../SPEC.md` actually work:

```bash
cd prototype
node --test        # 26 unit tests: pointer, detox, grading, observation contract
node gate.mjs      # golden corpus runner + acceptance gate (exit code decides)
```

## What is real here

| Piece | Status |
|---|---|
| Observation contract checks (`validateObservation`) | implemented — subset of `schema/observation.schema.json`, no schema library |
| Declarative detox engine (`detox`) | implemented — 7 normalizer ops, wildcard pointer expansion, never mutates input |
| Comparator ops (`COMPARATORS.instant`) | implemented — tolerance as a relation, not a transform |
| Graded comparator (`grade`) | implemented — equal / exact / normalized / semantic, plus the list of neutralised paths |
| Golden corpus + gate | 15 bidirectional cases, gate: 0 false alarms, >= 95% recall |
| HAR 1.2 importer | **not** implemented |
| Live shadow replayer | **not** implemented |

## The two design points this code settles

**1. Tolerance cannot be a normalizer.** Bucketing a timestamp into `floor(t / 2s)` looks
equivalent to "within 2 seconds" and is not: any pair straddling a bucket boundary is
mis-graded, which for a ±2s window is ~60% of cases. `instant` is therefore a
*comparator* — a relation between the two values, resolved during diffing. There is a test
for exactly the straddling pair.

**2. Rule coverage is depth-exact, never prefix-based.** A rule on `/items` must not
swallow "one item vanished from the page". Prefix matching would grade that as noise; the
corpus case *an item silently disappeared from page 2* exists to keep it from coming back.

## Known limits, stated rather than implied

- `write_set` is validated but not yet graded; the prototype only compares response bodies.
- Bodies are assumed to arrive already parsed as JSON. Media-type negotiation and binary
  payloads are unhandled.
- The corpus is 15 cases. Recall at this size is a smoke test, not a measurement — a real
  number needs a few hundred, mined from production traffic.