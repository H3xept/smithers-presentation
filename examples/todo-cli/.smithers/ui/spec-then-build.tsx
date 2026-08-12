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
 * The planning agent drafts a spec into `draft-spec`. This page seeds the
 * markdown editor from that row and the human rewrites it. Submitting delivers
 * the edited text to the parked `await-edit` node as a correlated signal and
 * then resumes the run, so `implement` builds from the human's words.
 */

/** The agent nodes whose live chat this page surfaces. */
const AGENT_NODE_IDS = [NODE_IDS.draftSpec, NODE_IDS.implement, NODE_IDS.test] as const;

const STAGES = [
  { nodeId: NODE_IDS.draftSpec, label: "draft spec" },
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

/** Both `draftSpec` and `editedSpec` rows, as far as this page cares. */
type SpecRow = { markdown?: string };

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
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const runsState = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 20 } });
  const activeRunId = selectedRunId ?? runsState.data?.[0]?.runId;

  const runState = useGatewayRun(activeRunId);
  const run = runState.data as RunFields | undefined;
  const runStatus = run?.status;
  const live = activeRunId !== undefined && runStatus !== undefined && SETTLED_STATUS[runStatus.toLowerCase()] !== true;

  const draftOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.draftSpec });
  const editedOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.awaitEdit });
  const testOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: NODE_IDS.test });
  const diffState = useGatewayRunDiff({ runId: activeRunId });
  const tokenState = useGatewayRunTokenUsage(activeRunId ?? "", { refreshMs: live ? 5000 : undefined });
  const { submitSignal, resumeRun } = useGatewayActions();

  const seedMarkdown = nodeRow<SpecRow>(draftOutput.data)?.markdown ?? "";
  const submittedMarkdown = nodeRow<SpecRow>(editedOutput.data)?.markdown ?? "";
  const testRow = nodeRow<TestRow>(testOutput.data);

  // The editor is seeded once per drafted spec and then owned by the human, so
  // a background refetch never yanks the caret out of a half-typed sentence.
  const editorSeed = submittedMarkdown || seedMarkdown || EDITOR_PLACEHOLDER;
  const editorValue = draftMarkdown ?? editorSeed;
  useEffect(() => {
    setDraftMarkdown(undefined);
    setSubmitError(undefined);
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

  const awaitingEdit = activeRunId !== undefined && seedMarkdown !== "" && submittedMarkdown === "";
  const canSubmit = awaitingEdit && !submitting && editorValue.trim() !== "";

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
        payload: { markdown: editorValue, editedBy: "human" },
      });
      await resumeRun({ runId: activeRunId });
      await editedOutput.refetch();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [activeRunId, editorValue, submitSignal, resumeRun, editedOutput]);

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
          description="Start a run to draft a spec, then edit it here before anything is implemented."
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
                      ? "The run is parked. Answer the open questions, then submit. This text is the build contract."
                      : "Waiting for the planning agent to draft the spec."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div style={layout.stack}>
                  <MarkdownEditor
                    aria-label="Feature spec"
                    value={editorValue}
                    resetKey={`${activeRunId}:${editorSeed.length}`}
                    readOnly={!awaitingEdit}
                    onChange={setDraftMarkdown}
                  />
                  <div style={layout.editorActions}>
                    <Button onClick={submit} disabled={!canSubmit}>
                      {submitting ? "Submitting…" : "Submit spec and resume"}
                    </Button>
                    <Button variant="outline" onClick={() => setDraftMarkdown(undefined)} disabled={!awaitingEdit}>
                      Reset to draft
                    </Button>
                  </div>
                  {submitError !== undefined ? (
                    <Alert variant="destructive">
                      <AlertTitle>Could not submit the spec</AlertTitle>
                      <AlertDescription>{submitError}</AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Tabs defaultValue="diff">
              <TabsList>
                <TabsTrigger value="diff" count={diffFiles.length}>
                  Diff
                </TabsTrigger>
                <TabsTrigger value="tests">Tests</TabsTrigger>
                <TabsTrigger value="chat" count={chatNodeIds.length}>
                  Agent chat
                </TabsTrigger>
              </TabsList>

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
