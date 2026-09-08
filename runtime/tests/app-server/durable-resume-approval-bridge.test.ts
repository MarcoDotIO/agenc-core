import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
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
        id: `${turnId}-started`,
        msg: {
          type: "turn_started",
          payload: { turnId, buildId: currentBuildId() },
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        id: `${turnId}-checkpoint`,
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

  function makeRunner(): AgenCDelegateBackgroundAgentRunner {
    return new AgenCDelegateBackgroundAgentRunner({
      bootstrap: (options) => bootstrapLocalRuntimeSession(options),
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
      },
    });
  }

  function restoreParams(): never {
    return {
      agentId: CONVERSATION_ID,
      objective: "resume after daemon death",
      cwd: workspace,
      resumeRolloutPath: rolloutPath,
      explicitColdResume: true,
      // The daemon snapshot is complete per client; keys absent from it are
      // cleared, so provider credentials must ride the override.
      envOverrides: { XAI_API_KEY: "test-key" },
    } as never;
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
});
