import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENC_DAEMON_HEARTBEAT_FRESH_MS,
  claimAbandonedDaemonHeartbeat,
  describeAbandonedDaemonExit,
  describeDaemonHeartbeat,
  describeUnboundDaemonHeartbeat,
  installAgenCDaemonHeartbeat,
  isDaemonHeartbeatFresh,
  readAgenCDaemonHeartbeat,
  reportLastDaemonHeartbeat,
  resolveAgenCDaemonHeartbeatPath,
  resolveAgenCDaemonPreviousHeartbeatPath,
} from "../../src/app-server/daemon-heartbeat.js";

// #2199: a daemon that dies in a way no handler can see leaves its last
// heartbeat behind, and `status` reports it beside "stopped".

let home = "";
let path = "";
const proc = {
  pid: 4242,
  memoryUsage: () => ({ rss: 600 * 1_048_576, heapUsed: 250 * 1_048_576 }),
  uptime: () => 1_620,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:39:00.000Z"));
  home = mkdtempSync(join(tmpdir(), "agenc-heartbeat-"));
  path = resolveAgenCDaemonHeartbeatPath(home);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("daemon heartbeat", () => {
  // #2225: the replacement daemon's heartbeat while it recovers, before its identity is published.
  const unbound = {
    pid: 149,
    beat: 45,
    at: "2026-09-06T12:38:57.000Z",
    uptimeS: 225,
    rssMb: 950,
    heapUsedMb: 700,
    eventLoopLagMs: 12,
  };

  // #2225: a daemon that is beating but has not published its identity is
  // reported as alive and not yet bound, not as indeterminate.
  it("treats a heartbeat within three intervals as fresh and older ones as stale", () => {
    const sent = Date.parse(unbound.at);
    const heartbeat = unbound;
    expect(isDaemonHeartbeatFresh(heartbeat, sent)).toBe(true);
    expect(isDaemonHeartbeatFresh(heartbeat, sent + AGENC_DAEMON_HEARTBEAT_FRESH_MS)).toBe(true);
    expect(isDaemonHeartbeatFresh(heartbeat, sent + AGENC_DAEMON_HEARTBEAT_FRESH_MS + 1)).toBe(false);
    // A clock that runs behind the writer must not turn a live daemon stale.
    expect(isDaemonHeartbeatFresh(heartbeat, sent - 60_000)).toBe(true);
  });

  it("describes an unbound daemon with its pid, the pending identity and its vitals", () => {
    const text = describeUnboundDaemonHeartbeat(unbound, Date.parse("2026-09-06T12:39:00.000Z"));
    expect(text.split("\n").filter(Boolean)).toEqual([
      "AgenC daemon alive but not yet bound (pid 149)",
      "  identity: not published yet (still starting, or the runtime record was removed); lifecycle commands wait for it",
      "  heartbeat: 3 s ago, rss 950 MB, heap 700 MB, event-loop lag 12 ms, up 4 min",
    ]);
  });

  it("writes a beat at once and on every interval, with pid, memory and lag", () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    try {
      expect(readAgenCDaemonHeartbeat(path)).toMatchObject({
        pid: 4242,
        beat: 1,
        rssMb: 600,
        heapUsedMb: 250,
        uptimeS: 1_620,
        eventLoopLagMs: 0,
      });
      vi.advanceTimersByTime(2_000);
      const third = readAgenCDaemonHeartbeat(path);
      expect(third?.beat).toBe(3);
      expect(third?.at).toBe("2026-09-06T12:39:02.000Z");
    } finally {
      dispose();
    }
  });

  it("measures a late tick as event-loop lag", () => {
    let drift = 0;
    const dispose = installAgenCDaemonHeartbeat({
      path,
      intervalMs: 1_000,
      proc,
      now: () => Date.now() + drift,
    });
    try {
      drift = 700; // the loop was busy; this tick observes the clock 700 ms late
      vi.advanceTimersByTime(1_000);
      expect(readAgenCDaemonHeartbeat(path)?.eventLoopLagMs).toBe(700);
    } finally {
      dispose();
    }
  });

  it("removes its own file on a clean stop and leaves another process's alone", () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    dispose();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 99 }));
    const disposeAgain = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    // The install overwrote the file with pid 4242; a later foreign write survives the disposer.
    writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 99 }));
    disposeAgain();
    expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(99);
  });

  it("rejects a malformed file", () => {
    writeFileSync(path, "{not json");
    expect(readAgenCDaemonHeartbeat(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: "4242", beat: 1, at: "x" }));
    expect(readAgenCDaemonHeartbeat(path)).toBeNull();
  });

  it("reports the vanished daemon's last heartbeat for its pid only", () => {
    installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc })();
    writeFileSync(path, `${JSON.stringify(readOrSample())}\n`);
    vi.setSystemTime(new Date("2026-09-06T12:39:45.000Z"));
    const lines: string[] = [];
    const io = { stderr: { write: (text: string) => lines.push(text) } };
    expect(reportLastDaemonHeartbeat(io, path, 4242)).toBe(true);
    expect(lines[0]).toContain("pid 4242");
    expect(lines[0]).toContain("45 s ago");
    expect(lines[0]).toContain("rss 600 MB");
    expect(lines[0]).toContain("event-loop lag 0 ms");
    expect(lines[0]).toContain("up 27 min");
    expect(reportLastDaemonHeartbeat(io, path, 1)).toBe(false);
    expect(reportLastDaemonHeartbeat(io, path, null)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  // #2199: the replacement's first beat used to overwrite the record of the
  // exit it was replacing, three seconds after it happened.
  describe("the heartbeat of the daemon this one replaced", () => {
    it("keeps a dead daemon's heartbeat where the next beat cannot reach it", () => {
      const previousPath = resolveAgenCDaemonPreviousHeartbeatPath(home);
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      const claimed = claimAbandonedDaemonHeartbeat({
        path,
        previousPath,
        pid: proc.pid,
        isPidRunning: () => false,
      });
      expect(claimed?.pid).toBe(79303);
      expect(existsSync(path)).toBe(false);
      const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
      try {
        expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(proc.pid);
        expect(readAgenCDaemonHeartbeat(previousPath)?.pid).toBe(79303);
      } finally {
        dispose();
      }
      // A clean stop removes this daemon's beat, never the kept exit.
      expect(readAgenCDaemonHeartbeat(previousPath)?.pid).toBe(79303);
    });

    it("describes the exit with the dead pid, the age and its last vitals", () => {
      expect(
        describeAbandonedDaemonExit(
          { ...readOrSample(), pid: 79303 },
          Date.parse("2026-09-06T12:39:45.000Z"),
        ),
      ).toBe(
        "the previous daemon (pid 79303) exited without recording a reason; " +
          "its last heartbeat was at 2026-09-06T12:39:00.000Z, 45 s ago: " +
          "rss 600 MB, heap 250 MB, event-loop lag 0 ms, up 27 min",
      );
    });

    it("leaves a live daemon's heartbeat, its own, and an absent one alone", () => {
      const previousPath = resolveAgenCDaemonPreviousHeartbeatPath(home);
      const claim = (isPidRunning: (pid: number) => boolean) =>
        claimAbandonedDaemonHeartbeat({ path, previousPath, pid: proc.pid, isPidRunning });
      expect(claim(() => false)).toBeNull(); // no heartbeat on disk
      // A takeover starts beside a running daemon: its file is still in use.
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      expect(claim((pid) => pid === 79303)).toBeNull();
      expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(79303);
      // A restart that reuses this process's own pid has nothing to report.
      writeFileSync(path, JSON.stringify(readOrSample()));
      expect(claim(() => false)).toBeNull();
      expect(existsSync(previousPath)).toBe(false);
    });

    it("does not report an exit a racing daemon already claimed", () => {
      const claimed = claimAbandonedDaemonHeartbeat({
        path,
        // An unwritable directory stands in for the rename another starting
        // daemon won: the file is gone from under this one either way.
        previousPath: join(home, "missing-dir", "daemon-heartbeat.prev.json"),
        pid: proc.pid,
        isPidRunning: () => false,
      });
      expect(claimed).toBeNull();
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      const stillOnDisk = claimAbandonedDaemonHeartbeat({
        path,
        previousPath: join(home, "missing-dir", "daemon-heartbeat.prev.json"),
        pid: proc.pid,
        isPidRunning: () => false,
      });
      // The rename failed but the evidence is still there and about to be
      // overwritten, so it is reported rather than lost in silence.
      expect(stillOnDisk?.pid).toBe(79303);
    });
  });

  it("describes long uptimes in hours", () => {
    const text = describeDaemonHeartbeat(
      { ...readOrSample(), uptimeS: 2 * 3600 + 5 * 60 },
      Date.parse("2026-09-06T12:39:00.000Z"),
    );
    expect(text).toContain("up 2 h 5 min");
  });
});

function readOrSample() {
  return {
    pid: 4242,
    beat: 7,
    at: "2026-09-06T12:39:00.000Z",
    uptimeS: 1_620,
    rssMb: 600,
    heapUsedMb: 250,
    eventLoopLagMs: 0,
  };
}
