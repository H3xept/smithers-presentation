# todo-cli

A tiny todo CLI: `src/cli.ts` exports `run(argv)`, `src/store.ts` keeps a flat JSON array.
It demonstrates one Smithers capability: a custom workflow UI with a human in the loop. One
agent drafts a feature spec, a second agent attacks that draft against the real code, and the
human keeps or throws out each correction while editing the result in the browser. The text
the human submits is what the implementer builds from. `DEMO.md` has the stage-by-stage script.

Run: `smithers up .smithers/workflows/spec-then-build.tsx -d && smithers ui`
