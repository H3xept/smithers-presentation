# flaky-monorepo

Twelve packages live under `packages/`. Each `index.ts` holds one real defect and each `index.test.ts` asserts the correct behaviour, so **the tests fail on purpose**: `bun test packages` reports 11 or 12 failures. `pkg-07` races the wall clock, so its result changes between runs. `pkg-11` also carries a real `tsc` error. Do not fix them; they are the fixture.

This repo demonstrates Smithers observability: a 12-lane parallel fan-out, a bounded retry loop inside every lane, token and latency budgets, and scorers on the roll-up.

Run it:

    smithers up .smithers/workflows/harden-packages.tsx
