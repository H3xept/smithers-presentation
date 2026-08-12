# Demo sub-repos

Three small repos for the Smithers talk. Each one shows exactly one capability,
and each one produces work that genuinely needs it.

| repo | shows | the line |
| --- | --- | --- |
| [`pricing-api`](./pricing-api) | human approval gates | "A rejection is an input, not an abort." |
+| [`flaky-monorepo`](./flaky-monorepo) | observability | "Twelve agents, one dashboard, one bill." |
| [`todo-cli`](./todo-cli) | a custom workflow UI | "You edit the agent's plan while it waits." |

Every repo is independently clonable. It has its own `package.json`, its own
`bun test`, and its own seeded `.smithers/` pack. Copying one folder is the
intended takeaway.

Read `<repo>/DEMO.md` for the exact command order and the speaker beats.

## Before the talk

1. `smithers oneshot --status` must print at least one usable agent.
2. Pre-warm all three runs. A fresh run is ten minutes of spinner.
3. Park `pricing-api` at its approval gate and `todo-cli` at its spec editor.
+4. Start the Docker stack for `flaky-monorepo`: `smithers observability --detach`.

`smithers graph`, `smithers timeline`, `smithers inspect`, and `smithers why`
read local state. They work with no network.
