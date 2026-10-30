import assert from "node:assert/strict";
import { parseLiveDataBatch } from "./kalshi-game-status-source";

/** One-shot public API contract check. No database, credentials, workers or Telegram. */
async function probe() {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length || ids.length > 100) throw new Error("Provide 1–100 current milestone IDs to verify populated live data.");
  async function read(milestones: string[]) {
    const query = new URLSearchParams();
    for (const id of milestones) query.append("milestone_ids", id);
    const response = await fetch(`https://external-api.kalshi.com/trade-api/v2/live_data/batch?${query}`,
      { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Live-data probe returned HTTP ${response.status}; no automatic retries.`);
    return response.json() as Promise<unknown>;
  }
  const empty = parseLiveDataBatch(await read(["00000000-0000-0000-0000-000000000000"]));
  assert.equal(empty.length, 0, "The absent milestone must not become a scoreboard.");
  await new Promise(resolve => setTimeout(resolve, 400));
  const boards = parseLiveDataBatch(await read(ids));
  assert.ok(boards.length > 0, "These sample milestones have no current live data; choose current IDs.");
  assert.ok(boards.every(board => ids.includes(board.milestone_id)), "Response must match the requested game identities.");
  console.info(`PASS: real empty response accepted; ${boards.length} populated boards matched by ID. States: ${boards.map(board => board.details.status ?? "unknown").join(", ")}. No database writes or Telegram calls.`);
}

probe().catch(error => {
  console.error(error instanceof Error ? error.message : "Live-data verification failed.");
  process.exitCode = 1;
});
