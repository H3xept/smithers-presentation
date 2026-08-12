# pricing-api

A tiny billing service. `prices.json` holds the tier table, `src/pricing.ts` exports `quote()`, and `consumers/checkout.ts` plus `consumers/reporting.ts` both call it. `CHANGE-REQUEST.md` is an incoming finance request for a price rise and a schema change.

It demonstrates a durable human approval gate. An agent proposes the change, a human approves or denies from the CLI, and a denial sends the proposal back for revision. Deciding and acting are separate nodes, so the decision stays reversible.

Run it: `smithers up .smithers/workflows/price-change.tsx`

Verify the graph without a model: `smithers graph .smithers/workflows/price-change.tsx`
