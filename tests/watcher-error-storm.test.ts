import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DirtyTracker } from "../src/dirty-tracker.js";

/**
 * A recursive watch does not fail once. Node walks the tree adding a watcher
 * per directory, and every directory it cannot cover emits its own `error` on
 * the watcher the caller holds. Against the inotify limit that is a burst, not
 * a single event.
 *
 * A `once` listener detaches after the first one, so the second reaches an
 * EventEmitter with no error handler and takes the whole host process down --
 * reported as a Pi crash on startup from a large home directory (issue #1).
 */
class FakeRecursiveWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  /** Replay what Node does when the watch limit is reached mid-walk. */
  emitEnospcBurst(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const error = Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), {
        errno: -28,
        syscall: "watch",
        code: "ENOSPC",
      });
      this.emit("error", error);
    }
  }
}

describe("recursive watcher error bursts", () => {
  it("survives repeated watcher errors instead of crashing the host", () => {
    const watcher = new FakeRecursiveWatcher();
    const tracker = new DirtyTracker("/tmp/does-not-need-to-exist", {
      watchFactory: () => watcher as unknown as FSWatcher,
    });
    tracker.start();

    // One error per directory Node failed to cover. A `once` listener would
    // leave every error after the first unhandled.
    expect(() => watcher.emitEnospcBurst(25)).not.toThrow();

    // A watcher that cannot cover the tree still holds inotify descriptors,
    // so it is released rather than left running. Releasing it is also what
    // puts the tracker back on its conservative path.
    expect(watcher.closed).toBe(true);

    tracker.stop();
  });

  it("keeps a healthy watcher attached across ordinary events", () => {
    const watcher = new FakeRecursiveWatcher();
    const tracker = new DirtyTracker("/tmp/does-not-need-to-exist", {
      watchFactory: () => watcher as unknown as FSWatcher,
    });
    tracker.start();

    watcher.emit("change", "change", "src/a.ts");
    watcher.emit("change", "change", "src/b.ts");

    expect(watcher.closed).toBe(false);

    tracker.stop();
  });

  it("emits errors on the caller's watcher, which is why `once` is wrong", () => {
    // Guards the assumption the fix rests on: Node's recursive watch reports
    // through the returned watcher, so a persistent listener does catch every
    // error -- a one-shot listener is what loses them.
    const watcher = new FakeRecursiveWatcher();
    const seen = vi.fn();
    watcher.on("error", seen);
    watcher.emitEnospcBurst(3);
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
