/** Read-only development benchmark; never starts workers or calls Kalshi. */
import { pool } from "@workspace/db";
import { getKalshiExplorer } from "./kalshi-explorer";
import { getRoiLeaderboard, getRoiSnapshot } from "./kalshi-roi-leaderboard";

async function main() {
  if (process.env.BOT_WORKERS_ENABLED !== "false") throw new Error("Requires paused development workers.");
  const samples: { operation: string; ms: number; rows: number }[] = [];
  const options = { groupBy: "segment" as const, window: "all" as const, band: "all" as const,
    direction: "all" as const, minGames: 50, page: 1, coverage: "verified" as const };
  const time = async (operation: string, load: () => Promise<number>) => {
    const began = performance.now();
    const rows = await load();
    samples.push({ operation, ms: Math.round((performance.now() - began) * 100) / 100, rows });
  };
  const now = new Date();
  await time("roi.all.cold", async () => (await getRoiSnapshot(options, now)).snapshot.rows.length);
  for (const band of ["small", "medium", "large"] as const) {
    await time(`roi.${band}.reuse`, async () => (await getRoiSnapshot({ ...options, band }, now)).snapshot.rows.length);
  }
  await time("ranking.first", async () => (await getRoiLeaderboard(options, now)).totalRows);
  await time("ranking.repeat", async () => (await getRoiLeaderboard(options, now)).totalRows);
  await time("catalog.cold", async () => (await getKalshiExplorer({ band: "large", scope: "active", window: "all" }, now)).markets.length);
  await time("catalog.repeat", async () => (await getKalshiExplorer({ band: "large", scope: "active", window: "all" }, now)).markets.length);
  process.stdout.write(JSON.stringify({ environment: "development", generatedAt: now.toISOString(), samples,
    note: "Saved development data only; these measurements do not establish production speed." }, null, 2) + "\n");
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }).finally(() => pool.end());
