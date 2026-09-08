import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import {
  bootstrapLocalRuntimeSession,
  type LocalRuntimeBootstrap,
} from "../../src/bin/bootstrap.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { resolveUnattendedPermissionDecision } from "../../src/permissions/unattended-policy.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import {
  currentBuildId,
  resetBuildIdForTestingOnly,
} from "../../src/session/durable-turns.js";
import {
  parseRolloutLine,
  type RolloutItem,
} from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import { VERSION } from "../../src/version.js";

/**
 * #2239 — a turn resumed after a daemon death ran with no approval resolver.
 *
 * The durable resume is driven from the startup prewarm INSIDE
 * `bootstrapLocalRuntimeSession`, so it completed before `restoreAgent` could
 * install `services.approvalResolver` (`#installDaemonApprovalBridge`) or
 * register the agent in `#active`. Every tool in the recovered turn that
 * needed approval hit the guardian arbiter's `default_deny`, the user was
 * never prompted, and the recovered turn was spent.
 *
 * These tests run the REAL bootstrap through the REAL runner: the session
 * under test is built by `buildBootstrapSessionServices`, so it carries every
 * service a production session carries (`guardianApprovalReviewer` included —
 * that service is set unconditionally and answers approvals only for
 * `approvalsReviewer: "auto_review"` turns, so its presence is NOT evidence
 * that anyone can answer a prompt).
 */

const CONVERSATION_ID = "session-durable-resume-approval";
const TURN_ID = "orphan-turn-2239";
const APPROVAL_REQUEST_ID = "resume-approval-probe";

interface ResumeObservation {
  readonly resume: boolean;
  readonly hasApprovalResolver: boolean;
  readonly hasGuardianApprovalReviewer: boolean;
}

/**
 * One started-but-never-terminated turn carrying a durable checkpoint whose
 * prefix is empty — the shape a SIGKILLed daemon leaves behind.
 */
function orphanRolloutItems(turnId: string): RolloutItem[] {
  return [
    {
      type: "event_msg",
      payload: {
        eventId: `${turnId}-started`,
        id: `${turnId}-started`,
        seq: 1,
        msg: {
          type: "turn_started",
          payload: { turnId, buildId: currentBuildId() },
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        eventId: `${turnId}-checkpoint`,
        id: `${turnId}-checkpoint`,
        seq: 2,
        msg: {
          type: "turn_checkpoint",
          payload: {
            turnId,
            iterationIndex: 1,
            boundary: "iteration",
            checkpointSeq: 1,
            persistedMessageCount: 0,
            prefixHash: computeCheckpointPrefixHashV3([], 0),
            checkpointVersion: 4,
            toolResultIntegrityVersion: 1,
            prefixHashVersion: 3,
            resumableState: {
              turnCount: 1,
              recoveryReentryCount: 0,
              maxOutputTokensRecoveryCount: 0,
              continuationNudgeCount: 0,
              stopHookBlockingCount: 0,
            },
          },
        },
      },
    },
  ] as unknown as RolloutItem[];
}

function readRollout(rolloutPath: string): RolloutItem[] {
  return readFileSync(rolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseRolloutLine(line))
    .filter((item): item is RolloutItem => item !== null);
}

describe("durable resume reaches the daemon approval bridge (#2239)", () => {
  let home = "";
  let workspace = "";
  let rolloutPath = "";
  let previousBuildId: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-2239-home-"));
    workspace = mkdtempSync(join(tmpdir(), "agenc-2239-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    previousBuildId = process.env.AGENC_BUILD_ID;
    process.env.AGENC_BUILD_ID = "resume-approval-build";
    resetBuildIdForTestingOnly();

    const seed = new RolloutStore({
      cwd: workspace,
      sessionId: CONVERSATION_ID,
      agencVersion: VERSION,
      agencHome: home,
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    seed.open({
      sessionId: CONVERSATION_ID,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      originator: "agenc-cli",
      source: "interactive-root",
      agencVersion: VERSION,
      model: "base-model",
      modelProvider: "grok",
    });
    for (const item of orphanRolloutItems(TURN_ID)) seed.appendRollout(item);
    rolloutPath = seed.rolloutPath;
    seed.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousBuildId === undefined) delete process.env.AGENC_BUILD_ID;
    else process.env.AGENC_BUILD_ID = previousBuildId;
    resetBuildIdForTestingOnly();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function stubProviderAndMcp(): void {
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  }

  async function stubProvider(): Promise<void> {
    const providerMod = await import("../../src/llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }),
        }) as never,
    );
  }

  function makeRunner(
    onBootstrapped?: (bootstrap: LocalRuntimeBootstrap) => void,
  ): AgenCDelegateBackgroundAgentRunner {
    return new AgenCDelegateBackgroundAgentRunner({
      bootstrap: async (options) => {
        const bootstrap = await bootstrapLocalRuntimeSession(options);
        onBootstrapped?.(bootstrap);
        return bootstrap;
      },
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
      },
    });
  }

  /** The daemon-recovered conversation the runner hydrates onto the session. */
  const RECOVERED_USER_MESSAGE = "PRIOR USER MESSAGE";
  const REPLAY_CALL_ID = "replay-1";

  function sessionHistory(
    bootstrap: LocalRuntimeBootstrap,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return (
      bootstrap.session as unknown as {
        readonly state: {
          with: <T>(
            fn: (state: { history?: ReadonlyArray<Record<string, unknown>> }) => T,
          ) => Promise<T>;
        };
      }
    ).state.with((state) => state.history ?? []);
  }

  /**
   * Record every event type the session emits, from before bootstrap runs.
   * Subscribing to `session.eventLog` after `restoreAgent` returns would miss
   * a resume that already happened inside bootstrap, which is exactly the
   * ordering these tests compare against.
   */
  function recordEmittedEventTypes(): string[] {
    const types: string[] = [];
    const emit = Session.prototype.emit;
    vi.spyOn(Session.prototype, "emit").mockImplementation(function (
      this: Session,
      event: Parameters<Session["emit"]>[0],
      appendOpts?: Parameters<Session["emit"]>[1],
    ) {
      types.push(event.msg.type);
      return emit.call(this, event, appendOpts);
    });
    return types;
  }

  async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function restoreParams(extra: Record<string, unknown> = {}): never {
    return {
      agentId: CONVERSATION_ID,
      objective: "resume after daemon death",
      cwd: workspace,
      resumeRolloutPath: rolloutPath,
      explicitColdResume: true,
      // The daemon snapshot is complete per client; keys absent from it are
      // cleared, so provider credentials must ride the override.
      envOverrides: { XAI_API_KEY: "test-key" },
      ...extra,
    } as never;
  }

  /**
   * Mark the seeded run as having a startup activation still pending, the
   * shape `restoreAgent` requires before it accepts
   * `resumeStartupActivationPending` (`currentCanonicalRuntimeStateFromRollout`
   * reads a `run_resumed` on the current epoch that no `run_startup_activated`
   * has closed).
   */
  function seedPendingStartupActivation(): void {
    const suspensionEventId = `run-suspended:${CONVERSATION_ID}:1`;
    const resumeEventId = `run-resumed:${CONVERSATION_ID}:1`;
    const lines = [
      {
        type: "event_msg",
        payload: {
          eventId: suspensionEventId,
          id: suspensionEventId,
          seq: 3,
          msg: {
            type: "run_suspended",
            payload: {
              runId: CONVERSATION_ID,
              epoch: 1,
              reason: "daemon_shutdown_idle",
              suspendedAt: new Date().toISOString(),
            },
          },
        },
        eventVersion: 1,
      },
      {
        type: "event_msg",
        payload: {
          eventId: resumeEventId,
          id: resumeEventId,
          seq: 4,
          msg: {
            type: "run_resumed",
            payload: {
              runId: CONVERSATION_ID,
              epoch: 1,
              suspensionEventId,
              reason: "daemon_startup_restore",
              resumedAt: new Date().toISOString(),
            },
          },
        },
        eventVersion: 1,
      },
    ];
    appendFileSync(
      rolloutPath,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      "utf8",
    );
  }

  /** The recovered-run state `daemon-cli` hands `restoreAgent` on a cold start. */
  function recoveredRunState(): Record<string, unknown> {
    return {
      currentSessionId: "recovered-session",
      initialMessages: [{ role: "user", content: RECOVERED_USER_MESSAGE }],
      replayToolCalls: [
        { callId: REPLAY_CALL_ID, toolName: "Glob", args: { pattern: "**/*" } },
      ],
    };
  }

  it("drives the recovered turn only once a client can answer its approvals", async () => {
    await stubProvider();
    stubProviderAndMcp();

    const runner = makeRunner();
    const observations: ResumeObservation[] = [];
    let approvalProbe: Promise<ReviewDecision> | undefined;
    const resumeDriven = Promise.withResolvers<void>();

    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      const services = this.services as {
        approvalResolver?: {
          request: (ctx: unknown) => Promise<ReviewDecision>;
        };
        guardianApprovalReviewer?: unknown;
      };
      const isResume = options?.resume !== undefined;
      observations.push({
        resume: isResume,
        hasApprovalResolver: services.approvalResolver !== undefined,
        hasGuardianApprovalReviewer:
          services.guardianApprovalReviewer !== undefined,
      });
      if (isResume) {
        // Ask for approval exactly the way `execute-tools` does, from inside
        // the resumed turn. This is the property the issue is about: the
        // request must become a pending decision the daemon can deliver to a
        // client, not an instant refusal.
        approvalProbe = services.approvalResolver?.request({
          callId: APPROVAL_REQUEST_ID,
          invocation: { session: { conversationId: CONVERSATION_ID } },
        });
        resumeDriven.resolve();
      }
      return (async function* () {
        return { reason: "completed" as const };
      })() as never;
    });

    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    await Promise.race([
      resumeDriven.promise,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("the recovered turn was never driven")),
          10_000,
        ),
      ),
    ]);

    expect(observations).toEqual([
      {
        resume: true,
        hasApprovalResolver: true,
        // Production shape marker: every canonical session carries this
        // service, so it can never stand in for "someone can answer".
        hasGuardianApprovalReviewer: true,
      },
    ]);

    // The approval is pending on the daemon, not denied: a client answer
    // reaches it. `#requestDaemonToolDecision` returns DENIED outright when
    // the agent is absent from `#active`, so this also proves the agent was
    // registered before the resumed turn ran.
    expect(approvalProbe).toBeDefined();
    let settled = false;
    void approvalProbe?.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await expect(
      runner.resolveToolDecision(CONVERSATION_ID, {
        requestId: APPROVAL_REQUEST_ID,
        decision: { kind: "approved" },
      }),
    ).resolves.toBe(true);
    await expect(approvalProbe).resolves.toEqual({ kind: "approved" });

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("keeps resuming inline for callers that do not defer (local CLI/TUI)", async () => {
    // The local TUI installs `session.services.approvalResolver` from a React
    // effect, i.e. after bootstrap returns, so it has no resolver at prewarm
    // time either. The fix must not make its resumes defer or fail: without
    // `deferDurableTurnResume` the resume still runs inside bootstrap, byte
    // for byte as before.
    await stubProvider();
    stubProviderAndMcp();

    const resumesDrivenDuringBootstrap: boolean[] = [];
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      if (options?.resume !== undefined) resumesDrivenDuringBootstrap.push(true);
      return (async function* () {
        return { reason: "completed" as const };
      })() as never;
    });

    const boot = await bootstrapLocalRuntimeSession({
      apiKey: "test-key",
      conversationId: CONVERSATION_ID,
      resumeConversation: true,
      resumeRolloutPath: rolloutPath,
      cwd: workspace,
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
        XAI_API_KEY: "test-key",
      },
    });
    try {
      expect(resumesDrivenDuringBootstrap).toEqual([true]);
      // Nothing was deferred, so the driver is an explicit no-op.
      await expect(boot.runDeferredDurableTurnResume?.()).resolves.toEqual({
        resumed: false,
      });
    } finally {
      await boot.shutdown();
    }
  }, 60_000);

  it("proves the recovered turn is single-shot: replay persists its abort", async () => {
    // Why the fix drives the resume in THIS process instead of deferring it
    // to some later user message: bootstrap replays the rollout with
    // `emitSynthesized: true`, which persists `turn_aborted{process_killed}`
    // for the orphan. Once that abort is on disk the turn yields no resume
    // descriptor ever again, so a deferral that never fires drops it.
    await stubProvider();
    stubProviderAndMcp();
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(
      () =>
        (async function* () {
          return { reason: "completed" as const };
        })() as never,
    );

    const before = reconstructFromRollout(readRollout(rolloutPath));
    expect(before.resumableTurns.map((turn) => turn.turnId)).toEqual([TURN_ID]);

    const runner = makeRunner();
    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);

    const persisted = readRollout(rolloutPath);
    const abortedTurnIds = persisted.flatMap((item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "turn_aborted" &&
      item.payload.msg.payload.reason === "process_killed"
        ? [item.payload.msg.payload.turnId]
        : [],
    );
    expect(abortedTurnIds).toContain(TURN_ID);
    expect(reconstructFromRollout(persisted).resumableTurns).toEqual([]);
  }, 60_000);

  it("keeps the daemon-recovered conversation the restore hydrated", async () => {
    // A cold daemon start hands `restoreAgent` the recovered run's own state:
    // `initialMessages` (the conversation from the last snapshot, including a
    // message the user had already queued) plus `replayToolCalls`, which are
    // re-dispatched and appended (daemon-cli.ts
    // `recoveredInitialMessages`/`recoveredReplayToolCalls`).
    // `#hydrateRecoveredAgentState` writes them onto `session.state.history`.
    //
    // The recovered turn writes that same slot: `syncSessionState` assigns
    // `sessionState.history` from the checkpoint prefix it was resumed with.
    // Driving the resume after hydration therefore ERASES the recovered
    // conversation. Whatever order the resume runs in, the end state must
    // still carry it.
    await stubProvider();
    stubProviderAndMcp();

    const eventTypes = recordEmittedEventTypes();
    let booted: LocalRuntimeBootstrap | undefined;
    const runner = makeRunner((bootstrap) => {
      booted = bootstrap;
    });

    await expect(
      runner.restoreAgent(restoreParams(recoveredRunState())),
    ).resolves.toBe(true);
    const bootstrap = booted!;

    // At return the hydrated conversation is present on both the fixed and the
    // unfixed source; the regression only shows once the resumed turn settles.
    expect(
      (await sessionHistory(bootstrap)).map((message) => message.role),
    ).toEqual(["user", "assistant", "tool"]);

    // Sample only after the recovered turn has actually started AND finished,
    // otherwise the assertion races an unstarted resume and passes for the
    // wrong reason.
    await waitUntil(
      () => eventTypes.includes("turn_resumed"),
      "the recovered turn to start",
    );
    await waitUntil(
      () => bootstrap.session.activeTurn.unsafePeek() === null,
      "the recovered turn to settle",
    );
    // The restoration of the recovered conversation is chained onto the
    // resume, so give that chain a bounded window and then assert, rather
    // than turning the property under test into a timeout message.
    await waitUntil(
      async () =>
        (await sessionHistory(bootstrap)).some(
          (message) =>
            message.role === "user" &&
            message.content === RECOVERED_USER_MESSAGE,
        ),
      "the recovered conversation to survive the resumed turn",
      5_000,
    ).catch(() => undefined);

    const history = await sessionHistory(bootstrap);
    expect(
      history.some(
        (message) =>
          message.role === "user" && message.content === RECOVERED_USER_MESSAGE,
      ),
    ).toBe(true);
    expect(
      history.some(
        (message) =>
          message.role === "tool" && message.toolCallId === REPLAY_CALL_ID,
      ),
    ).toBe(true);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("does not return before the recovered turn has started", async () => {
    // `restoreAgent` returning while the resume is still queued leaves a
    // window: a client that submits in it has its brand-new turn aborted
    // `replaced` by the late resume (`Session.spawnTask` ->
    // `abortAllTasksLocked("replaced")`). The recovered turn must already own
    // the session's turn slot by the time restore reports success, so the
    // newer user message replaces the resume and never the other way round.
    await stubProvider();
    stubProviderAndMcp();

    const eventTypes = recordEmittedEventTypes();
    const runner = makeRunner();

    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    // `turn_resumed` is emitted right after `spawnTask` installed the
    // recovered turn as the session's active turn.
    expect(eventTypes).toContain("turn_resumed");

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("never withholds the resume from a restore that defers startup side effects", async () => {
    // A suspended / startup-activation-pending restore passes
    // `deferAgentStartupSideEffects: true`, which hands the WHOLE startup
    // prewarm — the durable resume with it — to whoever activates it later,
    // by which time the approval bridge and the `#active` entry exist. The two
    // deferrals must therefore be mutually exclusive: setting both would mark
    // the resume pending inside a prewarm nobody can pair with a
    // `runDeferredDurableTurnResume` call, and the orphan is single-shot, so
    // the turn would be lost rather than late.
    //
    // Out of scope, unchanged, pre-existing: `bin/bootstrap.ts` gates the
    // prewarm block itself on the same flag, so today nothing runs it for
    // those restores at all. This test pins that whoever does run it resumes
    // the orphan, with the daemon approval bridge already installed.
    await stubProvider();
    stubProviderAndMcp();
    seedPendingStartupActivation();
    expect(
      reconstructFromRollout(readRollout(rolloutPath)).resumableTurns.map(
        (turn) => turn.turnId,
      ),
    ).toEqual([TURN_ID]);

    const observations: ResumeObservation[] = [];
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      const services = this.services as {
        approvalResolver?: unknown;
        guardianApprovalReviewer?: unknown;
      };
      observations.push({
        resume: options?.resume !== undefined,
        hasApprovalResolver: services.approvalResolver !== undefined,
        hasGuardianApprovalReviewer:
          services.guardianApprovalReviewer !== undefined,
      });
      return (async function* () {
        return { reason: "completed" as const };
      })() as never;
    });

    let booted: LocalRuntimeBootstrap | undefined;
    const bootstrapOptions: Array<Record<string, unknown>> = [];
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: async (options) => {
        bootstrapOptions.push(options as unknown as Record<string, unknown>);
        booted = await bootstrapLocalRuntimeSession(options);
        return booted;
      },
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
      },
    });

    await expect(
      runner.restoreAgent(
        restoreParams({ resumeStartupActivationPending: true }),
      ),
    ).resolves.toBe(true);

    expect(bootstrapOptions).toHaveLength(1);
    expect(bootstrapOptions[0]!.deferAgentStartupSideEffects).toBe(true);
    expect(bootstrapOptions[0]!.deferDurableTurnResume).toBeUndefined();
    // Nothing ran the prewarm yet, so no turn of any kind was driven.
    expect(observations).toEqual([]);

    // Whoever activates the deferred startup work drives the resume inline,
    // and by then the bridge this issue is about is installed.
    const manager = (
      booted!.session.services as {
        readonly conversationThreadManager?: {
          runStartupPrewarm: (session: unknown) => Promise<unknown>;
        };
      }
    ).conversationThreadManager;
    await manager!.runStartupPrewarm(booted!.session);

    expect(observations).toEqual([
      {
        resume: true,
        hasApprovalResolver: true,
        hasGuardianApprovalReviewer: true,
      },
    ]);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("runs the recovered turn under the agent's unattended policy", async () => {
    // Documented consequence of resuming after `installUnattendedPermissionPolicy`
    // instead of inside bootstrap: the recovered turn is now subject to the
    // agent's configured unattended allow/deny lists, where before it always
    // reached the arbiter's `default_deny`. That is the configured behavior of
    // an unattended agent — an allowlisted tool runs without a prompt and a
    // denylisted one is refused without one — and it is asserted here rather
    // than left to be discovered.
    await stubProvider();
    stubProviderAndMcp();

    const decisions: Array<Record<string, unknown>> = [];
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      if (options?.resume !== undefined) {
        const context = this.permissionModeRegistry!.current();
        decisions.push({
          mode: context.mode,
          glob: resolveUnattendedPermissionDecision(context, "Glob").behavior,
          exec: resolveUnattendedPermissionDecision(context, "exec_command")
            .behavior,
          edit: resolveUnattendedPermissionDecision(context, "Edit").behavior,
        });
      }
      return (async function* () {
        return { reason: "completed" as const };
      })() as never;
    });

    const runner = makeRunner();
    await expect(
      runner.restoreAgent(
        restoreParams({
          metadata: {
            unattendedAllow: ["Glob"],
            unattendedDeny: ["exec_command"],
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(decisions).toEqual([
      { mode: "unattended", glob: "allow", exec: "deny", edit: "pause" },
    ]);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);
});
