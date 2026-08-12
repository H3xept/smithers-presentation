/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeEvents,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunDiff,
  useGatewayRunTokenUsage,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import {
  ConnectionBadge,
  LaunchButton,
  MonitorButton,
  NodeChatStream,
  NodeStageStrip,
  RunList,
  RunTree,
  WorkflowUiShell,
  unwrapNodeOutput,
} from "smithers-orchestrator/gateway-ui";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DiffHunks,
  EmptyState,
  KpiStat,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  parseUnifiedFile,
  type DiffFile,
} from "smithers-orchestrator/ui";
import { MarkdownEditor, MarkdownEditorStyles } from "smithers-orchestrator/ui/adapters/markdown-editor";
import { Terminal, type TerminalWriter } from "smithers-orchestrator/ui/adapters/terminal";
import { NODE_IDS, SPEC_CORRELATION_KEY, SPEC_EVENT, WORKFLOW_KEY } from "./spec-then-build-contract";

/**
 * The `spec-then-build` run UI.
 *
 * The planning agent drafts a spec into `draft-spec`. The reviewer attacks that
 * draft in `critique` and returns the spec it would rather build. This page
 * seeds the markdown editor from the reviewer's rewrite, lists every correction
 * it made, and lets the human throw any of them out - a rejection puts the
 * drafted wording back, in place, without disturbing the rest of the text.
 * Submitting delivers the final markdown to the parked `await-edit` node as a
 * correlated signal and resumes the run, so `implement` builds from the human's
 * words and is told which corrections were refused.
 */

/** The agent nodes whose live chat this page surfaces. */
const AGENT_NODE_IDS = [NODE_IDS.draftSpec, NODE_IDS.critique, NODE_IDS.implement, NODE_IDS.test] as const;

const STAGES = [
  { nodeId: NODE_IDS.draftSpec, label: "draft spec" },
  { nodeId: NODE_IDS.critique, label: "review" },
  { nodeId: NODE_IDS.awaitEdit, label: "human edit" },
  { nodeId: NODE_IDS.implement, label: "implement" },
  { nodeId: NODE_IDS.test, label: "test" },
];

/** Run statuses that mean the run will not move again on its own. */
const SETTLED_STATUS: Record<string, true> = {
  done: true,
  ok: true,
  complete: true,
  completed: true,
  failed: true,
  error: true,
  cancelled: true,
  canceled: true,
};

const EDITOR_PLACEHOLDER = "# Spec\n\nWaiting for the planning agent to draft the spec.\n";

/** Structural layout only. Every colour and border comes from the components. */
const layout = {
  meta: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" } as const,
  kpis: { display: "flex", gap: 12, flexWrap: "wrap" } as const,
  columns: { display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: 16 } as const,
  sidebar: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, marginTop: 16 } as const,
  stack: { display: "grid", gap: 12 } as const,
  editorActions: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as const,
  scroll: { maxHeight: 420, overflow: "auto" } as const,
  correction: { display: "grid", gap: 6 } as const,
  correctionHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } as const,
  swap: { display: "grid", gap: 4, margin: 0, fontSize: ".78rem", lineHeight: 1.45, whiteSpace: "pre-wrap" } as const,
};

/*
 * The gateway serves run rows and node output rows as `Record<string, unknown>`
 * even though the workflow's zod schemas fix their shape. Each row is narrowed
 * exactly once, at the boundary below, and read as a named type everywhere else.
 */

/** The `getRun` fields this page reads. */
type RunFields = {
  status?: string;
  startedAtMs?: number;
  createdAtMs?: number;
  finishedAtMs?: number;
};

/** The `draftSpec` row, and the `editedSpec` row's markdown. */
type SpecRow = { markdown?: string };

/**
 * The submitted `editedSpec` row. The store serves its columns in snake case
 * and serialises the id array, so both spellings and both shapes are real.
 */
type EditedRow = {
  markdown?: string;
  rejectedCorrections?: readonly string[] | string;
  rejected_corrections?: readonly string[] | string;
};

/** Ids of the corrections a submitted row records as thrown out. */
function parseRejected(row: EditedRow | undefined): readonly string[] {
  const raw = row?.rejectedCorrections ?? row?.rejected_corrections;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** One correction the reviewer proposes, as the `critique` row carries it. */
type Correction = {
  id: string;
  severity?: string;
  target?: string;
  problem?: string;
  before?: string;
  after?: string;
};

/**
 * The `critique` row: a verdict, a rewritten spec, and what it changed.
 *
 * The store serialises the `corrections` array into its column, so the row can
 * arrive with that field as JSON text. Both shapes are real; `parseCorrections`
 * is the one place that resolves them.
 */
type CritiqueRow = {
  verdict?: string;
  markdown?: string;
  corrections?: Correction[] | string;
  unfaulted?: string;
};

function parseCorrections(critique: CritiqueRow | undefined): readonly Correction[] {
  const raw = critique?.corrections;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Correction[]) : [];
  } catch {
    return [];
  }
}

/** Severity to badge variant. Anything unrecognised stays quiet. */
const SEVERITY_VARIANT: Record<string, "destructive" | "warning" | "muted"> = {
  blocker: "destructive",
  risk: "warning",
  nit: "muted",
};

/** The `test` row's counters. */
type TestRow = { passed?: number; failed?: number };

/** Peel the `{ status, row }` node-output envelope and name the row's shape. */
function nodeRow<Row>(data: unknown): Row | undefined {
  const row = unwrapNodeOutput(data).row;
  return row !== null && typeof row === "object" ? (row as Row) : undefined;
}

function runIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

/** A live-ticking clock, so elapsed keeps moving while the run is open. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Live `bun test` output. `NodeOutput` frames carry the raw stdout/stderr text
 * chunks for one node; each frame is written into the emulator exactly once.
 */
function TestTerminal({ runId }: { runId: string | undefined }) {
  const { events } = useGatewayNodeEvents(runId, NODE_IDS.test, { maxEvents: 500 });
  const writeRef = useRef<TerminalWriter | undefined>(undefined);
  const drainedSeqRef = useRef(-1);

  // The emulator is re-keyed per run, so its write cursor restarts with it.
  useEffect(() => {
    drainedSeqRef.current = -1;
  }, [runId]);

  const stream = useCallback((write: TerminalWriter) => {
    writeRef.current = write;
    return () => {
      writeRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const write = writeRef.current;
    if (!write) return;
    for (const frame of events) {
      if (frame.seq <= drainedSeqRef.current) continue;
      drainedSeqRef.current = frame.seq;
      if (frame.event !== "NodeOutput") continue;
      let payload = frame.payload;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          continue;
        }
      }
      const chunk = (payload as { text?: string } | null)?.text;
      if (typeof chunk === "string" && chunk !== "") write(chunk);
    }
  }, [events]);

  return <Terminal key={runId ?? "no-run"} readOnly stream={stream} scrollback={5000} style={{ height: 420 }} />;
}

export function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [draftMarkdown, setDraftMarkdown] = useState<string | undefined>(undefined);
  const [rejectedIds, setRejectedIds] = useState<readonly string[]>([]);
  const [unappliable, setUnappliable] = useState<string | undefined>(undefined);
  // `MarkdownEditor` deliberately reseeds its document only when `resetKey`
  // changes, so a background refetch cannot move the caret. Every programmatic
  // rewrite of the text - a rejected correction, a reset - has to bump this or
  // the state changes while the visible document does not.
  const [seedNonce, setSeedNonce] = useState(0);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const runsState = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 20 } });
  const activeRunId = selectedRunId ?? runsState.data?.[0]?.runId;

  const runState = useGatewayRun(activeRunId);
  const run = runState.data as RunFields | undefined;
  const runStatus = run?.status;
  const live = activeRunId !== undefined && runStatus !== undefined && SETTLED_STATUS[runStatus.toLowerCase()] !== true;

  const draftOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.draftSpec });
  const critiqueOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.critique });
  const editedOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.awaitEdit });
  const testOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.test });
  const diffState = useGatewayRunDiff({ runId: activeRunId });
  const tokenState = useGatewayRunTokenUsage(activeRunId ?? "", { refreshMs: live ? 5000 : undefined });
  const { submitSignal, resumeRun } = useGatewayActions();

  const draftedMarkdown = nodeRow<SpecRow>(draftOutput.data)?.markdown ?? "";
  const critique = nodeRow<CritiqueRow>(critiqueOutput.data);
  const corrections = parseCorrections(critique);
  const reviewedMarkdown = critique?.markdown ?? "";
  const editedRow = nodeRow<EditedRow>(editedOutput.data);
  const submittedMarkdown = editedRow?.markdown ?? "";
  // Before the submit the rejections are local state; after it they are a fact
  // in the row, and the row outlives this page.
  const shownRejected = submittedMarkdown === "" ? rejectedIds : parseRejected(editedRow);
  const testRow = nodeRow<TestRow>(testOutput.data);

  // The editor is seeded once per agent text and then owned by the human, so a
  // background refetch never yanks the caret out of a half-typed sentence. The
  // reviewer's rewrite wins the seed wherever it exists: the human edits a
  // reviewed document, never a first draft.
  const editorSeed = submittedMarkdown || reviewedMarkdown || draftedMarkdown || EDITOR_PLACEHOLDER;
  const editorValue = draftMarkdown ?? editorSeed;
  useEffect(() => {
    setDraftMarkdown(undefined);
    setRejectedIds([]);
    setUnappliable(undefined);
    setSubmitError(undefined);
    setSeedNonce(0);
  }, [activeRunId, editorSeed]);

  const now = useNow(live);
  const startedAtMs = run?.startedAtMs ?? run?.createdAtMs ?? 0;
  const finishedAtMs = run?.finishedAtMs ?? 0;
  const elapsed = startedAtMs > 0 ? (finishedAtMs > 0 ? finishedAtMs : now) - startedAtMs : 0;

  const totalTokens = useMemo(
    () =>
      (tokenState.data?.events ?? []).reduce(
        (sum, event) =>
          sum +
          event.inputTokens +
          event.outputTokens +
          event.cacheReadTokens +
          event.cacheWriteTokens +
          event.reasoningTokens,
        0,
      ),
    [tokenState.data],
  );

  const diffFiles = useMemo<DiffFile[]>(() => {
    const bundle = diffState.data;
    if (bundle === undefined || !("patches" in bundle)) return [];
    return bundle.patches.map((patch) => parseUnifiedFile(patch.diff, { path: patch.path }));
  }, [diffState.data]);

  const awaitingEdit = activeRunId !== undefined && reviewedMarkdown !== "" && submittedMarkdown === "";
  const canSubmit = awaitingEdit && !submitting && editorValue.trim() !== "";

  /**
   * Reject a correction by putting the drafted wording back, or restore it by
   * re-applying the reviewer's. Either direction is one literal substring swap
   * on whatever is in the editor right now, so a half-typed sentence elsewhere
   * survives it. When the text is no longer there verbatim - the human already
   * rewrote that section, or the reviewer invented the passage outright and
   * there is nothing to put back - say so rather than silently doing nothing.
   */
  const toggleCorrection = useCallback(
    (correction: Correction) => {
      const rejecting = !rejectedIds.includes(correction.id);
      const needle = rejecting ? (correction.after ?? "") : (correction.before ?? "");
      const replacement = rejecting ? (correction.before ?? "") : (correction.after ?? "");
      if (needle === "" || !editorValue.includes(needle)) {
        setUnappliable(
          `${correction.id} cannot be swapped automatically: ${
            needle === ""
              ? "it added text rather than replacing any, so there is no original wording to restore."
              : "that wording is no longer in the editor verbatim."
          } Edit the section by hand instead.`,
        );
        return;
      }
      setUnappliable(undefined);
      setDraftMarkdown(editorValue.replace(needle, replacement));
      setRejectedIds(rejecting ? [...rejectedIds, correction.id] : rejectedIds.filter((id) => id !== correction.id));
      setSeedNonce((nonce) => nonce + 1);
    },
    [editorValue, rejectedIds],
  );

  const submit = useCallback(async () => {
    if (!activeRunId) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      // Two calls, in this order. The signal fills the parked wait node's row;
      // resumeRun is what actually wakes the suspended run back up.
      //
      // `signalName` is NOT optional here. A wait node resolves only when BOTH
      // the signal name and the correlation id match its snapshot, and the
      // gateway defaults a missing signalName to the correlationKey — which
      // would never equal the node's `event`. Send both, always.
      await submitSignal({
        runId: activeRunId,
        signalName: SPEC_EVENT,
        correlationKey: SPEC_CORRELATION_KEY,
        payload: {
          markdown: editorValue,
          editedBy: "human",
          basedOn: reviewedMarkdown === "" ? "draft" : "reviewed",
          rejectedCorrections: [...rejectedIds],
        },
      });
      await resumeRun({ runId: activeRunId });
      await editedOutput.refetch();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [activeRunId, editorValue, reviewedMarkdown, rejectedIds, submitSignal, resumeRun, editedOutput]);

  const chatNodeIds: readonly string[] =
    selectedNodeId !== undefined && (AGENT_NODE_IDS as readonly string[]).includes(selectedNodeId)
      ? [selectedNodeId]
      : AGENT_NODE_IDS;

  return (
    <WorkflowUiShell
      title="Spec Then Build"
      testId="spec-then-build-ui"
      meta={
        <div style={layout.meta}>
          <ConnectionBadge />
          <div style={layout.kpis}>
            <KpiStat label="Elapsed" value={formatElapsed(elapsed)} hint={runStatus ?? "no run"} />
            <KpiStat
              label="Tokens"
              value={totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : String(totalTokens)}
              hint="all agent nodes"
            />
            <KpiStat
              label="Corrections"
              value={corrections.length === 0 ? "—" : `${corrections.length - shownRejected.length}/${corrections.length}`}
              hint={critique === undefined ? "not reviewed yet" : `reviewer says ${critique.verdict ?? "?"}`}
            />
            <KpiStat
              label="Tests passing"
              value={testRow ? String(testRow.passed ?? 0) : "—"}
              hint={testRow ? `${testRow.failed ?? 0} failing` : "not run yet"}
            />
          </div>
        </div>
      }
      actions={
        <>
          <LaunchButton workflow={WORKFLOW_KEY} onLaunched={setSelectedRunId}>
            Start a run
          </LaunchButton>
          <MonitorButton runId={activeRunId} />
        </>
      }
    >
      <MarkdownEditorStyles />
      {activeRunId === undefined ? (
        <EmptyState
          title="No spec-then-build run yet"
          description="Start a run to draft a spec, have it reviewed, then edit the result here before anything is implemented."
          action={
            <LaunchButton workflow={WORKFLOW_KEY} onLaunched={setSelectedRunId}>
              Start a run
            </LaunchButton>
          }
        />
      ) : (
        <>
          <NodeStageStrip runId={activeRunId} stages={STAGES} showSummary />

          <div style={layout.columns}>
            <Card>
              <CardHeader>
                <CardTitle>The spec</CardTitle>
                <CardDescription>
                  {submittedMarkdown
                    ? "Submitted. The implementer is building from this text."
                    : awaitingEdit
                      ? "The reviewer's rewrite, parked and waiting for you. Throw out any correction, answer the open questions, then submit. This text is the build contract."
                      : draftedMarkdown
                        ? "Drafted. The reviewer is attacking it now."
                        : "Waiting for the planning agent to draft the spec."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div style={layout.stack}>
                  <MarkdownEditor
                    aria-label="Feature spec"
                    value={editorValue}
                    resetKey={`${activeRunId}:${editorSeed.length}:${seedNonce}`}
                    readOnly={!awaitingEdit}
                    onChange={setDraftMarkdown}
                  />
                  <div style={layout.editorActions}>
                    <Button onClick={submit} disabled={!canSubmit}>
                      {submitting ? "Submitting…" : "Submit spec and resume"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDraftMarkdown(undefined);
                        setRejectedIds([]);
                        setUnappliable(undefined);
                        setSeedNonce((nonce) => nonce + 1);
                      }}
                      disabled={!awaitingEdit}
                    >
                      Reset to the reviewed text
                    </Button>
                  </div>
                  {submitError !== undefined ? (
                    <Alert variant="destructive">
                      <AlertTitle>Could not submit the spec</AlertTitle>
                      <AlertDescription>{submitError}</AlertDescription>
                    </Alert>
                  ) : null}
                  {unappliable !== undefined ? (
                    <Alert>
                      <AlertTitle>Correction not swapped</AlertTitle>
                      <AlertDescription>{unappliable}</AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Tabs defaultValue="reviewer">
              <TabsList>
                <TabsTrigger value="reviewer" count={corrections.length}>
                  Reviewer
                </TabsTrigger>
                <TabsTrigger value="diff" count={diffFiles.length}>
                  Diff
                </TabsTrigger>
                <TabsTrigger value="tests">Tests</TabsTrigger>
                <TabsTrigger value="chat" count={chatNodeIds.length}>
                  Agent chat
                </TabsTrigger>
              </TabsList>

              <TabsContent value="reviewer">
                {critique === undefined ? (
                  <EmptyState
                    title="Not reviewed yet"
                    description="The reviewer reads the draft against the real code and rewrites it. Every correction it makes lands here, and you can throw any of them out."
                  />
                ) : (
                  <div style={{ ...layout.stack, ...layout.scroll }}>
                    <div style={layout.correctionHead}>
                      <Badge
                        variant={
                          critique.verdict === "sound" ? "success" : critique.verdict === "broken" ? "destructive" : "warning"
                        }
                      >
                        {critique.verdict ?? "unknown"}
                      </Badge>
                      <CardDescription>{critique.unfaulted}</CardDescription>
                    </div>
                    {corrections.length === 0 ? (
                      <EmptyState title="No corrections" description="The reviewer could not fault the draft." />
                    ) : (
                      corrections.map((correction) => {
                        const isRejected = shownRejected.includes(correction.id);
                        return (
                          <Card key={correction.id}>
                            <CardHeader>
                              <div style={layout.correctionHead}>
                                <Badge variant={SEVERITY_VARIANT[correction.severity ?? ""] ?? "secondary"}>
                                  {correction.severity ?? "note"}
                                </Badge>
                                <CardTitle>{correction.target ?? correction.id}</CardTitle>
                                {isRejected ? <Badge variant="muted">rejected</Badge> : null}
                              </div>
                              <CardDescription>{correction.problem}</CardDescription>
                            </CardHeader>
                            <CardContent>
                              <div style={layout.correction}>
                                <CardDescription>draft</CardDescription>
                                <pre style={layout.swap}>
                                  <code>
                                    {correction.before === "" ? "(nothing - the reviewer added this)" : correction.before}
                                  </code>
                                </pre>
                                <CardDescription>reviewer</CardDescription>
                                <pre style={layout.swap}>
                                  <code>{correction.after}</code>
                                </pre>
                                <div style={layout.editorActions}>
                                  <Button
                                    variant={isRejected ? "default" : "outline"}
                                    onClick={() => toggleCorrection(correction)}
                                    disabled={!awaitingEdit}
                                  >
                                    {isRejected ? "Restore this correction" : "Reject and put the draft back"}
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="diff">
                {diffFiles.length === 0 ? (
                  <EmptyState
                    title="No changes yet"
                    description="The implementation diff appears here once the implement node writes to the repo."
                  />
                ) : (
                  <div style={{ ...layout.stack, ...layout.scroll }}>
                    {diffFiles.map((file) => (
                      <DiffHunks key={file.path} file={file} />
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tests">
                <TestTerminal runId={activeRunId} />
              </TabsContent>

              <TabsContent value="chat">
                <div style={layout.stack}>
                  {chatNodeIds.map((nodeId) => (
                    <NodeChatStream key={nodeId} runId={activeRunId} nodeId={nodeId} title={nodeId} height={320} />
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div style={layout.sidebar}>
            <Card>
              <CardHeader>
                <CardTitle>Nodes</CardTitle>
                <CardDescription>Pick an agent node to watch only its chat.</CardDescription>
              </CardHeader>
              <CardContent>
                <RunTree
                  runId={activeRunId}
                  activeNodeId={selectedNodeId}
                  onSelectNode={(node) => setSelectedNodeId(node.id === selectedNodeId ? undefined : node.id)}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Runs</CardTitle>
                <CardDescription>Every spec-then-build run in this workspace.</CardDescription>
              </CardHeader>
              <CardContent>
                <RunList
                  filter={{ workflow: WORKFLOW_KEY, limit: 20 }}
                  activeRunId={activeRunId}
                  onSelect={setSelectedRunId}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </WorkflowUiShell>
  );
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<App />);
}
