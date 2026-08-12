/**
 * The signal contract shared by the `spec-then-build` workflow and its UI.
 *
 * The workflow parks on `<WaitForEvent event={SPEC_EVENT}
 * correlationId={SPEC_CORRELATION_KEY}>`. The UI delivers the human's edited
 * markdown with `submitSignal({ correlationKey: SPEC_CORRELATION_KEY, ... })`.
 * Both sides read these constants so the two strings can never drift apart.
 */

/** Event name the wait node listens for. */
export const SPEC_EVENT = "spec.edited";

/** Correlation key that pairs one signal with that wait node. */
export const SPEC_CORRELATION_KEY = "spec-then-build-edit";

/** Workflow key, as mounted on the gateway. */
export const WORKFLOW_KEY = "spec-then-build";

/** The four top-level node ids, in pipeline order. */
export const NODE_IDS = {
  draftSpec: "draft-spec",
  awaitEdit: "await-edit",
  implement: "implement",
  test: "test",
} as const;
