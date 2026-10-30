/** Bounded work; every item is awaited and failures are reported to the caller. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  const failed = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
