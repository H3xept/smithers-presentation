# todo-cli

A tiny todo CLI: `src/cli.ts` exports `run(argv)`, `src/store.ts` keeps a flat JSON array.
It demonstrates one Smithers capability: a custom workflow UI with a human in the loop. An
agent drafts a feature spec, the human edits that spec in the browser, and the edited text
is what the implementer builds from. `DEMO.md` has the stage-by-stage script.

Run: `smithers up .smithers/workflows/spec-then-build.tsx -d && smithers ui`
