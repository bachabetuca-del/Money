import type { Request, Response } from "express";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { db, kalshiAlertsTable as trades, kalshiGameStatusTable as games,
  kalshiResultsTable as results, kalshiTradeHistoryTable as imports, kalshiSettlementsTable as settlements } from "@workspace/db";
import {
  buildHistoryExportParts, EXPORT_COLUMNS, exportMetadata, exportTrade, HISTORY_EXPORT_ROWS_PER_PART,
  serializeHistoryChunk,
} from "./history-export-format";

export type HistoryExportPartSelection = { part: number; snapshotAt: Date };

export async function getKalshiHistoryExportParts() {
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
    latestSavedAt: sql<string | null>`max(${trades.savedAt})::text`,
  }).from(trades);
  const snapshotAt = counts?.latestSavedAt ? new Date(counts.latestSavedAt) : new Date();
  return buildHistoryExportParts(Number(counts?.total ?? 0), snapshotAt.toISOString());
}

/** Bounded server memory, backpressure and one consistent read-only snapshot. */
export async function streamHistoryExport(
  req: Request,
  res: Response,
  format: "json" | "csv",
  part?: HistoryExportPartSelection,
) {
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
  let invalidPart = false;
  await db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '60000'`);
    const snapshotFilter = part ? lte(trades.savedAt, part.snapshotAt) : undefined;
    const [counts] = await tx.select({
      total: sql<number>`count(*)::int`, markets: sql<number>`count(distinct ${trades.ticker})::int`,
      from: sql<string | null>`min(${trades.createdTime})::text`,
      to: sql<string | null>`max(${trades.createdTime})::text`,
    }).from(trades).where(snapshotFilter);
    const totalTrades = Number(counts?.total ?? 0);
    const totalParts = Math.ceil(totalTrades / HISTORY_EXPORT_ROWS_PER_PART);
    if (part && part.part > totalParts) {
      invalidPart = true;
      return;
    }
    const partOffset = part ? (part.part - 1) * HISTORY_EXPORT_ROWS_PER_PART : 0;
    const expectedTrades = part
      ? Math.min(HISTORY_EXPORT_ROWS_PER_PART, Math.max(0, totalTrades - partOffset))
      : totalTrades;
    const at = new Date().toISOString();
    const baseMetadata = exportMetadata(totalTrades, counts.markets,
      counts.from ? new Date(counts.from).toISOString() : null,
      counts.to ? new Date(counts.to).toISOString() : null, at);
    const metadata = part ? {
      ...baseMetadata,
      part: {
        number: part.part,
        totalParts,
        tradesInPart: expectedTrades,
        rowsPerPart: HISTORY_EXPORT_ROWS_PER_PART,
        snapshotAt: part.snapshotAt.toISOString(),
        note: "Partes ordenadas por ID; todas comparten el mismo corte de historial guardado.",
      },
    } : baseMetadata;
    const filename = part
      ? `kalshi-historial-parte-${String(part.part).padStart(2, "0")}-de-${String(totalParts).padStart(2, "0")}.json`
      : `kalshi-historico-${at.slice(0, 10)}.${format}`;
    res.set({
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store", "X-Accel-Buffering": "no",
      "X-Export-Trade-Count": String(expectedTrades),
    });
    await write(format === "json" ? `{"metadata":${JSON.stringify(metadata)},"trades":[` : "\uFEFF" + EXPORT_COLUMNS.join(",") + "\r\n");
    let cursor: string | undefined;
    let written = 0;
    while (written < expectedTrades) {
      if (res.destroyed) throw new Error("Download cancelled");
      const pageSize = Math.min(1000, expectedTrades - written);
      const query = tx.select({
        trade: trades, startsAt: games.startsAt, state: games.state, gameResult: results.gameResult,
        historyPhase: imports.phase, historyMinimum: imports.captureMinimum,
        milestoneId: games.milestoneId, statusSource: games.source, statusCheckedAt: games.checkedAt,
        officialResult: settlements.result, settlementTerminal: settlements.terminal,
        settlementCheckedAt: settlements.checkedAt, settlementError: settlements.error,
      }).from(trades)
        .leftJoin(games, eq(games.ticker, trades.ticker))
        .leftJoin(results, eq(results.ticker, trades.ticker))
        .leftJoin(imports, eq(imports.ticker, trades.ticker))
        .leftJoin(settlements, eq(settlements.ticker, trades.ticker))
        .where(and(cursor ? gt(trades.tradeId, cursor) : undefined, snapshotFilter))
        .orderBy(asc(trades.tradeId));
      const rows = cursor === undefined && part
        ? await query.limit(pageSize).offset(partOffset)
        : await query.limit(pageSize);
      if (!rows.length) break;
      const records = rows.map(row => exportTrade(row.trade, row));
      await write(serializeHistoryChunk(records, format, written > 0));
      written += records.length;
      cursor = rows.at(-1)!.trade.tradeId;
    }
    if (written !== expectedTrades) throw new Error("Incomplete history export");
    if (format === "json") await write("]}");
  });
  if (invalidPart) {
    res.status(400).json({ error: "Esa parte ya no pertenece al corte del historial. Vuelve a prepararlo." });
    return;
  }
  res.end();
}
