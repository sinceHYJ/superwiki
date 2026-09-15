import { describe, expect, it } from "vitest";
import { filterSnapshot, planSync } from "./engine";
import type { SyncEntry, SyncSnapshot } from "./types";

const file = (path: string, hash: string): SyncEntry => ({ path, kind: "file", hash, size: 1 });
const directory = (path: string): SyncEntry => ({ path, kind: "directory" });
const deleted = (path: string): SyncEntry => ({ path, kind: "deleted" });
const snapshot = (...entries: SyncEntry[]): SyncSnapshot => Object.fromEntries(entries.map((entry) => [entry.path, entry]));

describe("planSync", () => {
  it("merges unique files and empty directories on first sync", () => {
    const plan = planSync(null, snapshot(file("local.md", "a"), directory("empty")), snapshot(file("cloud.md", "b")));
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations.map((operation) => [operation.kind, operation.path])).toEqual([
      ["download", "cloud.md"],
      ["createRemoteDirectory", "empty"],
      ["upload", "local.md"],
    ]);
  });

  it("requires a choice when both initial versions differ", () => {
    const plan = planSync(null, snapshot(file("guide.md", "local")), snapshot(file("guide.md", "remote")));
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].initial).toBe(true);
  });

  it("propagates one-sided edits", () => {
    const base = snapshot(file("guide.md", "old"));
    expect(planSync(base, snapshot(file("guide.md", "new")), base).operations[0].kind).toBe("upload");
    expect(planSync(base, base, snapshot(file("guide.md", "new"))).operations[0].kind).toBe("download");
  });

  it("detects two-sided edits", () => {
    const plan = planSync(snapshot(file("guide.md", "old")), snapshot(file("guide.md", "local")), snapshot(file("guide.md", "remote")));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].initial).toBe(false);
  });

  it("propagates deletion and protects tombstones on a new device", () => {
    const base = snapshot(file("gone.md", "old"));
    expect(planSync(base, {}, base).operations[0].kind).toBe("deleteRemote");
    expect(planSync(base, base, snapshot(deleted("gone.md"))).operations[0].kind).toBe("deleteLocal");
    expect(planSync(null, snapshot(file("gone.md", "stale")), snapshot(deleted("gone.md"))).operations[0].kind).toBe("deleteLocal");
  });

  it("treats deletion against an edit as a conflict", () => {
    const base = snapshot(file("guide.md", "old"));
    expect(planSync(base, snapshot(file("guide.md", "new")), snapshot(deleted("guide.md"))).conflicts).toHaveLength(1);
  });
});

describe("filterSnapshot", () => {
  it("limits comparisons to the opened subtree", () => {
    const entries = snapshot(file("a/one.md", "1"), file("a/nested/two.md", "2"), file("b/three.md", "3"));
    expect(Object.keys(filterSnapshot(entries, "a"))).toEqual(["a/one.md", "a/nested/two.md"]);
  });
});
