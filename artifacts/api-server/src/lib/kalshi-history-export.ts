import type { Request, Response } from "express";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, kalshiAlertsTable as trades, kalshiGameStatusTable as games,
  kalshiResultsTable as results, kalshiTradeHistoryTable as imports } from "@workspace/db";
import { csvTrade, EXPORT_COLUMNS, exportMetadata, exportTrade } from "./history-export-format";

/** Bounded server memory, backpressure and one consistent read-only snapshot. */
export async function streamHistoryExport(req: Request, res: Response, format: "json" | "csv") {
  const write = async (text: string) => {
    if (res.destroyed || req.destroyed && !req.complete) throw new Error("Download cancelled");
    if (res.write(text)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { res.off("drain", drained); res.off("close", closed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error("Download cancelled")); };
      res.once("drain", drained); res.once("close", closed);
    });
  };
  await db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '60000'`);
    const [counts] = await tx.select({
      total: sql<number>`count(*)::int`, markets: sql<number>`count(distinct ${trades.ticker})::int`,
      from: sql<string | null>`min(${trades.createdTime})::text`,
      to: sql<string | null>`max(${trades.createdTime})::text`,
    }).from(trades);
    const at = new Date().toISOString();
    const metadata = exportMetadata(counts.total, counts.markets,
      counts.from ? new Date(counts.from).toISOString() : null,
      counts.to ? new Date(counts.to).toISOString() : null, at);
    res.set({
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kalshi-historico-${at.slice(0, 10)}.${format}"`,
      "Cache-Control": "private, no-store", "X-Accel-Buffering": "no",
      "X-Export-Trade-Count": String(counts.total),
    });
    await write(format === "json" ? `{"metadata":${JSON.stringify(metadata)},"trades":[` : "\uFEFF" + EXPORT_COLUMNS.join(",") + "\r\n");
    let cursor: string | undefined;
    let written = 0;
    for (;;) {
      if (res.destroyed) throw new Error("Download cancelled");
      const rows = await tx.select({
        trade: trades, startsAt: games.startsAt, state: games.state, gameResult: results.gameResult,
        historyPhase: imports.phase, historyMinimum: imports.captureMinimum,
      }).from(trades)
        .leftJoin(games, eq(games.ticker, trades.ticker))
        .leftJoin(results, eq(results.ticker, trades.ticker))
        .leftJoin(imports, eq(imports.ticker, trades.ticker))
        .where(and(cursor ? gt(trades.tradeId, cursor) : undefined))
        .orderBy(asc(trades.tradeId)).limit(1000);
      if (!rows.length) break;
      const output: string[] = [];
      for (const row of rows) {
        const record = exportTrade(row.trade, row);
        output.push(format === "json"
          ? (written ? "," : "") + JSON.stringify(record)
          : csvTrade(record));
        written++;
      }
      await write(output.join(""));
      cursor = rows.at(-1)!.trade.tradeId;
    }
    if (written !== counts.total) throw new Error("Incomplete history export");
    if (format === "json") await write("]}");
  });
  res.end();
}
