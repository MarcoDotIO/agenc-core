import { randomUUID } from "node:crypto";
import type { AgenCDaemonAgentManager } from "../app-server/agent-lifecycle.js";
import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { RoutineExecutionUnsettledError, type RoutineExecutor } from "./service.js";

/** Fresh canonical Core agent/session per invocation; permission decisions stay in Core. */
export function createDaemonRoutineExecutor(options: {
  agentManager: Pick<AgenCDaemonAgentManager, "createAgent" | "streamAgentMessage" | "cancelRunTree" | "stopAgent" | "finishRoutineRun">;
  runtimeOptions: AgentRuntimeOptions;
}): RoutineExecutor {
  const authority = Object.freeze({
    ...options.runtimeOptions,
    dangerouslyBypassApprovalsAndSandbox: false,
    allowUntrustedHooks: false,
    stdinDataMode: false,
    remoteMode: false,
  });
  return {
    async execute(routine, run, context) {
      if (context.signal.aborted) return "cancelled";
      let agentId: string | undefined;
      let cancellation: Promise<unknown> | undefined;
      let finalized = false;
      let resolveCancellation!: (value: { terminal: { code: 130 } }) => void;
      let rejectCancellation!: (error: unknown) => void;
      const cancellationOutcome = new Promise<{ terminal: { code: 130 } }>((resolve, reject) => { resolveCancellation = resolve; rejectCancellation = reject; });
      void cancellationOutcome.catch(() => {});
      const stop = async (): Promise<void> => {
        if (agentId === undefined || finalized) return;
        try { await options.agentManager.stopAgent({ agentId, reason: "Routine invocation finished" }); finalized = true; }
        catch { throw new RoutineExecutionUnsettledError("Core could not confirm routine quiescence."); }
      };
      const cancel = (): void => {
        if (agentId !== undefined && cancellation === undefined) {
          cancellation = options.agentManager.cancelRunTree({ runId: agentId, reason: "Routine run cancelled" }).catch(async (error) => { await stop(); throw error; });
          void cancellation.then(() => resolveCancellation({ terminal: { code: 130 } }), rejectCancellation);
          // The same rejection is awaited below; the signal callback must not reject globally.
          void cancellation.catch(() => {});
        }
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const agent = await options.agentManager.createAgent({
          objective: routine.name, cwd: routine.cwd, deferInitialTurn: true,
          ...(routine.provider ? { provider: routine.provider } : {}),
          ...(routine.model ? { model: routine.model } : {}),
          permissionMode: routine.permissionMode, runtimeOptions: authority,
          metadata: { routineId: routine.id, routineRunId: run.id },
        });
        agentId = agent.agentId;
        if (!agent.sessionId) throw new Error("Core did not create a routine session.");
        context.bind({ agentId, sessionId: agent.sessionId, coreRunId: agentId });
        if (context.signal.aborted) { cancel(); await cancellation; return "cancelled"; }
        const messageId = `routine_message_${randomUUID()}`;
        const result = await Promise.race([options.agentManager.streamAgentMessage({
          sessionId: agent.sessionId, content: routine.instructions,
          messageId, streamId: `routine_stream_${randomUUID()}`,
          acceptedAt: new Date().toISOString(), ifBusy: "reject", methodName: "message.stream",
        }), cancellationOutcome]);
        if (context.signal.aborted) { cancel(); await cancellation; return "cancelled"; }
        const outcome = await options.agentManager.finishRoutineRun(agentId, messageId);
        finalized = true;
        return outcome ?? (result.terminal?.code === 0 ? "completed" : result.terminal?.code === 130 ? "cancelled" : "failed");
      } finally {
        context.signal.removeEventListener("abort", cancel);
        if (agentId !== undefined) {
          if (context.signal.aborted) { cancel(); await cancellation; }
          else await stop();
        }
      }
    },
  };
}
