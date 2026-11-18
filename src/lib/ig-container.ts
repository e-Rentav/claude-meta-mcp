/**
 * Poll Instagram media containers until they finish processing, within a
 * deadline. Not finishing in time is a normal outcome (returned, not thrown):
 * the caller hands the container ids back so they can be published later.
 */

export interface ContainerStatus {
  status_code?: string;
  status?: string;
}

export interface PollDeps {
  getStatus(containerId: string): Promise<ContainerStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PollResult {
  ready: boolean;
  statuses: Record<string, string>;
}

const DONE = new Set(["FINISHED", "PUBLISHED"]);
const FAILED = new Set(["ERROR", "EXPIRED"]);

export async function pollContainers(containerIds: string[], deadlineMs: number, deps: PollDeps): Promise<PollResult> {
  const statuses: Record<string, string> = {};
  const pending = new Set(containerIds);
  let delay = 1500;
  for (;;) {
    for (const id of [...pending]) {
      const s = await deps.getStatus(id);
      const code = s.status_code ?? "UNKNOWN";
      statuses[id] = code;
      if (DONE.has(code)) pending.delete(id);
      else if (FAILED.has(code)) {
        throw new Error(`Instagram media container ${id} entered ${code}${s.status ? ` (${s.status})` : ""}`);
      }
    }
    if (pending.size === 0) return { ready: true, statuses };
    const remaining = deadlineMs - deps.now();
    if (remaining <= 0) return { ready: false, statuses };
    await deps.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 1.4, 6000);
  }
}
