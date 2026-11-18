type Timing = { operation: string; durationMs: number; failed: boolean };
let observer: ((timing: Timing) => void) | undefined;

/** Installed by server bootstrap; query modules stay usable in offline audits
 * without pulling the server's logging transport into the database package. */
export function observeSlowSavedReads(report: (timing: Timing) => void) {
  observer = report;
}

/** Fixed operation names only: never log query text, tokens or owner data. */
export async function timedSavedRead<T>(operation: string, load: () => T | Promise<T>): Promise<T> {
  const began = performance.now();
  let failed = true;
  try {
    const result = await load();
    failed = false;
    return result;
  } finally {
    const durationMs = Math.round(performance.now() - began);
    if (durationMs >= 1000) {
      try { observer?.({ operation, durationMs, failed }); } catch { /* Diagnostics never change reads. */ }
    }
  }
}
