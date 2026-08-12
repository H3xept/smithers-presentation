# Demo — observability

Workflow id: `harden-packages`. Run every command from `examples/flaky-monorepo`.

## The repo

Twelve packages sit under `packages/pkg-01` … `pkg-12`. Each one holds a small pure
function with exactly one real defect, plus a test that asserts the correct
behaviour. The suite therefore fails today, and that is the point.

Three properties make the repo a good observability fixture:

- `bun test packages` reports 11 or 12 failures out of 22 tests. Nothing is green.
- `packages/pkg-07` reads the wall clock directly, so its test result changes
  between runs. This lane retries while the other eleven pass first time.
- `packages/pkg-11` also carries a real type error at `index.ts(10,9)`. The test
  suite cannot see it. Only `bunx tsc --noEmit` reports it.

## The flow

```
discover
  └── <Aspects tokenBudget latencySlo>
        └── <Parallel id="lanes" maxConcurrency={12}>
              pkg-01:lane … pkg-12:lane      (12 sibling <Loop> lanes)
                └── pkg-NN:fix → pkg-NN:verify   (up to 3 rounds per lane)
typecheck
report                                        (3 scorers attached)
```

27 nodes render in total: `discover`, 24 lane tasks, `typecheck`, `report`.

Each lane owns its own loop, so a failed `verify` retries that one package and
leaves the other eleven alone. Lane rows are correlated by the `pkg` id field, so
a retry never mixes one package's result into another's.

## Which parts need Docker

| Stage | Needs the Docker stack | Reads local state offline |
| --- | --- | --- |
| Grafana and Tempo views | yes | no |
| `smithers graph` | no | yes |
| `smithers timeline` / `inspect` / `why` / `scores` | no | yes |
| `smithers what` | no | reads local state, calls a cheap model to narrate |

Everything except the Grafana and Tempo panels works with the stack down. If Docker
is unavailable on stage, skip stage 1 and stage 4 and run the CLI beats instead.

## Stage 0 — show the fixture

```sh
bun test packages
bunx tsc --noEmit
```

> "Twelve packages, twelve defects, and the tests already know what correct looks
> like. One of them also fails to type-check, and the test suite cannot see that."

Offline. No Smithers, no model.

## Stage 1 — start the observability stack

```sh
smithers observability --detach
```

This brings up an OTLP collector, Prometheus, Tempo, Loki, and Grafana through
Docker Compose. Ports on the host:

| Service | URL |
| --- | --- |
| Grafana | http://localhost:3001 (anonymous viewer; admin password `admin`) |
| Prometheus | http://localhost:9090 |
| Tempo query API | http://localhost:3200 |
| Loki | http://localhost:3100 |
| OTLP HTTP intake | http://localhost:4318 |

Open the provisioned dashboard **Smithers Overview** (uid `smithers-overview`).

> "Before anything runs, the dashboard is flat. Watch it fill up."

Needs Docker.

## Stage 2 — run the workflow with telemetry on

```sh
SMITHERS_OTEL_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=harden-packages-strong \
smithers up .smithers/workflows/harden-packages.tsx \
  --input '{"fixSeat":"strong"}' \
  --annotations '{"seat":"strong"}' \
  --max-concurrency 12 \
  --detach
```

`--max-concurrency 12` lets all twelve lanes dispatch at once. Without it the
engine caps at 4 and the trace looks narrow. Note the printed run id.

> "One command starts twelve agents. Each one owns a single package and may not
> touch another."

Needs Docker only for the export. The run itself works without it.

## Stage 3 — watch the shape while it runs

```sh
smithers status <run>
smithers inspect <run> --watch
```

> "Twelve lanes in flight. The engine is tracking each one separately, so a
> failure in one lane cannot stall the other eleven."

Offline.

## Stage 4 — the three things to point at in Grafana and Tempo

Open Grafana at http://localhost:3001.

**1. Twelve parallel spans.** In Grafana, choose the Tempo data source, search for
the trace by service name `harden-packages-strong`, and open it. Point at the
waterfall: twelve `pkg-NN:fix` spans start together and sit side by side under the
`lanes` group.

> "This is what fan-out looks like. Twelve spans, one start time, twelve independent
> lifetimes."

**2. One lane with a nested retry.** In the same waterfall, find `pkg-07`. Its lane
has a second `pkg-07:fix` and `pkg-07:verify` pair nested under the loop, because
the first verify raced the clock and lost. Every other lane has one pair.

> "Only pkg-07 retried. The retry is scoped to that lane, so eleven packages did not
> pay for one flaky clock."

**3. Tokens per node.** On the **Smithers Overview** dashboard, use the *Node
Throughput* and *Node Duration* panels for shape. For cost, query Prometheus
directly:

```promql
sum by (model) (smithers_smithers_tokens_input_total)
sum by (model) (smithers_smithers_tokens_output_total)
histogram_quantile(0.95, sum(rate(smithers_smithers_tokens_output_per_call_bucket[5m])) by (le))
```

> "Tokens are labelled by agent and model, so cost is a dimension of the dashboard,
> not a spreadsheet you keep on the side."

Needs Docker.

## Stage 5 — scores

```sh
smithers scores <run>
smithers scores <run> --node report
```

Three scorers run on `report`: `schemaAdherenceScorer` for shape, `latencyScorer`
for speed against a 30 s target and a 180 s ceiling, and an `llmJudge` called
`rollup-accuracy` that rates the roll-up against the per-package evidence it was
handed.

> "The run does not just finish. It grades itself, and the grade is a row you can
> query later."

Offline.

## Stage 6 — cheap model versus strong model

Run the same workflow a second time with the cheap seat. The workflow reads
`fixSeat` from its input and swaps the whole fan-out onto `agents.cheapFast`.

```sh
SMITHERS_OTEL_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=harden-packages-cheap \
smithers up .smithers/workflows/harden-packages.tsx \
  --input '{"fixSeat":"cheap"}' \
  --annotations '{"seat":"cheap"}' \
  --max-concurrency 12 \
  --detach
```

Then compare both runs on one dashboard. In Grafana, the token panels split by
`model`, so the two seats appear as separate series on the same graph:

```promql
sum by (model) (smithers_smithers_tokens_output_total)
sum by (model) (smithers_smithers_tokens_input_total)
```

And compare the two grades side by side:

```sh
smithers scores <strong-run> --node report
smithers scores <cheap-run>  --node report
smithers ps
```

> "Same graph, same twelve packages, different seat. The cheap seat costs a fraction
> of the tokens. Now look at how many retries it needed and what the judge thought of
> its roll-up. That trade is now a measurement, not an opinion."

Needs Docker for the panels. `smithers scores` works offline.

## Stage 7 — read the run back offline

```sh
smithers timeline <run>
smithers timeline <run> --tree
smithers what <run>
smithers what <run> --node pkg-07:fix
smithers inspect <run>
smithers inspect <run> --pool
smithers why <run>
```

`timeline` shows execution order and any forks. `--tree` follows forks
recursively. `what` narrates the recorded facts. `inspect --pool` tallies attempts
by agent engine and model, which is the same cheap-versus-strong comparison without
Grafana. `why` explains a blocked or paused run.

> "Every claim on that dashboard is also a row in local state. When the stack is
> down, the CLI answers the same questions."

Offline. `smithers what` calls a cheap model to narrate; the rest is pure local read.

## Offline fallback — no Docker, no model

```sh
smithers graph .smithers/workflows/harden-packages.tsx
```

Exits 0 and prints all 27 nodes, the twelve `pkg-NN:lane` loops, the propagated
`aspects` block on every lane task, and the three scorers on `report`. This is the
dry-run path; it never calls a model.

> "The graph is the contract. Twelve lanes, a retry loop in each, budgets pushed down
> to every task, and scorers on the roll-up — all provable before a single token is
> spent."

## Reset

```sh
smithers observability --down
bun test packages   # still 11 or 12 failures; the fixture is unchanged
```
