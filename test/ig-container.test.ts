import { test } from "node:test";
import assert from "node:assert/strict";
import { pollContainers, type ContainerStatus, type PollDeps } from "../src/lib/ig-container.js";

/** Fake clock: sleep advances time instantly. */
function deps(sequences: Record<string, ContainerStatus[]>): PollDeps & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  const idx: Record<string, number> = {};
  return {
    slept,
    async getStatus(id) {
      const seq = sequences[id];
      const i = Math.min(idx[id] ?? 0, seq.length - 1);
      idx[id] = (idx[id] ?? 0) + 1;
      return seq[i];
    },
    async sleep(ms) {
      slept.push(ms);
      t += ms;
    },
    now: () => t,
  };
}

test("returns ready immediately when the container is already FINISHED", async () => {
  const d = deps({ c1: [{ status_code: "FINISHED" }] });
  assert.deepEqual(await pollContainers(["c1"], 90_000, d), { ready: true, statuses: { c1: "FINISHED" } });
  assert.equal(d.slept.length, 0);
});

test("waits through IN_PROGRESS until FINISHED", async () => {
  const d = deps({ c1: [{ status_code: "IN_PROGRESS" }, { status_code: "IN_PROGRESS" }, { status_code: "FINISHED" }] });
  const r = await pollContainers(["c1"], 90_000, d);
  assert.equal(r.ready, true);
  assert.equal(d.slept.length, 2);
});

test("hands back not-ready (no throw) when the deadline passes, never sleeping past it", async () => {
  const d = deps({ c1: [{ status_code: "IN_PROGRESS" }] });
  const r = await pollContainers(["c1"], 10_000, d);
  assert.deepEqual(r, { ready: false, statuses: { c1: "IN_PROGRESS" } });
  assert.equal(d.slept.reduce((a, b) => a + b, 0), 10_000);
});

test("waits for every child and stops polling the finished ones", async () => {
  const d = deps({
    a: [{ status_code: "FINISHED" }],
    b: [{ status_code: "IN_PROGRESS" }, { status_code: "FINISHED" }],
  });
  const r = await pollContainers(["a", "b"], 90_000, d);
  assert.deepEqual(r, { ready: true, statuses: { a: "FINISHED", b: "FINISHED" } });
});

test("ERROR throws with Meta's status detail; PUBLISHED counts as done", async () => {
  await assert.rejects(
    pollContainers(["c1"], 90_000, deps({ c1: [{ status_code: "ERROR", status: "Error: Media download has failed" }] })),
    /ERROR \(Error: Media download has failed\)/
  );
  const r = await pollContainers(["c1"], 90_000, deps({ c1: [{ status_code: "PUBLISHED" }] }));
  assert.equal(r.ready, true);
});
