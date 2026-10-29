import OpenAI from "openai";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db, kalshiAlertsTable as trades, kalshiAnalysisTable,
  kalshiTradeHistoryTable } from "@workspace/db";
import { AnalyzeKalshiGameResponse, type GameAnalysis } from "@workspace/api-zod";
import { telegramDashboardStore } from "./telegram-dashboard-store";
import { buildCatalog } from "./telegram-dashboard-view";
import { publicDirection } from "./telegram-trade-direction";
import { ANALYSIS_MODEL, ANALYSIS_PROMPT, AnalysisError, GameAnalysisService, type GameContext } from "./game-analysis";

export function analysisAvailable() {
  return Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}
export async function loadGameAnalysis(ticker: string): Promise<GameAnalysis | null> {
  const [row] = await db.select().from(kalshiAnalysisTable).where(eq(kalshiAnalysisTable.ticker, ticker)).limit(1);
  return row ? AnalyzeKalshiGameResponse.parse(row.report) : null;
}

/** No upstream polling: derive bounded AI context from the entire saved game. */
export async function loadGameContext(ticker: string, now = new Date()): Promise<GameContext> {
  const catalog = buildCatalog(await telegramDashboardStore.markets({
    minimum: 0, minimumInclusive: true, maximum: null,
  }));
  const selected = catalog.find(m => m.ticker === ticker);
  if (!selected) throw new AnalysisError("No hay un partido guardado para ese mercado.", 404);
  const game = catalog.filter(m => m.gameKey === selected.gameKey);
  // Selected bet is never omitted. Bound model input, not the aggregate counts.
  const included = [selected, ...game.filter(m => m.ticker !== ticker).sort((a, b) => b.trades - a.trades)].slice(0, 32);
  const ids = included.map(m => m.ticker);
  const condition = and(inArray(trades.ticker, game.map(m => m.ticker)),
    lte(trades.createdTime, now), lte(trades.savedAt, now));
  const band = sql<string>`case when ${trades.notional} < 1000 then 'below_1000'
    when ${trades.notional} <= 5000 then '1000_to_5000'
    when ${trades.notional} < 10000 then 'over_5000_under_10000' else '10000_and_above' end`;
  const [groups, latest, coverage] = await Promise.all([
    db.select({
      ticker: trades.ticker, outcome: trades.outcomeSide, book: trades.bookSide, band,
      count: sql<number>`count(*)::int`, usd: sql<string>`sum(${trades.notional})::text`,
      latestAt: sql<string>`max(${trades.createdTime})::text`,
    }).from(trades).where(condition).groupBy(trades.ticker, trades.outcomeSide, trades.bookSide, band),
    db.selectDistinctOn([trades.ticker], {
      ticker: trades.ticker, price: trades.price, outcome: trades.outcomeSide,
      book: trades.bookSide, createdAt: trades.createdTime,
    }).from(trades).where(and(condition, inArray(trades.ticker, ids)))
      .orderBy(asc(trades.ticker), desc(trades.createdTime), asc(trades.tradeId)),
    db.select({ ticker: kalshiTradeHistoryTable.ticker, phase: kalshiTradeHistoryTable.phase,
      captureMinimum: kalshiTradeHistoryTable.captureMinimum, updatedAt: kalshiTradeHistoryTable.updatedAt })
      .from(kalshiTradeHistoryTable).where(inArray(kalshiTradeHistoryTable.ticker, ids)),
  ]);
  const totalTrades = groups.reduce((sum, g) => sum + g.count, 0);
  if (!totalTrades) throw new AnalysisError("No hay operaciones guardadas antes de la fecha de corte.", 404);
  const latestTradeAt = groups.reduce<string | null>((last, g) => {
    const time = new Date(g.latestAt).toISOString();
    return !last || time > last ? time : last;
  }, null);
  return {
    gameName: selected.gameName, selectedBet: selected.betLabel, selectedTicker: ticker,
    sport: selected.sport, dataThrough: now.toISOString(), latestTradeAt, totalTrades,
    totalMarkets: game.length, includedMarkets: included.length,
    gameState: selected.gameState ?? "unknown", startsAt: selected.gameStartsAt ?? null,
    finalScore: selected.gameResult ?? null,
    scope: "All saved bands and execution times for this game, not current dashboard filters.",
    limitations: "Incomplete exchange coverage. No verified sports statistics, injuries, lineups, order book, current quotes or confirmed position sales. No calibrated probability model.",
    markets: included.map(m => ({
      ticker: m.ticker, bet: m.betLabel.slice(0, 300),
      flowByBandAndDirection: groups.filter(g => g.ticker === m.ticker).map(g => ({
        band: g.band, direction: publicDirection(g.outcome, undefined, g.book),
        executions: g.count, usd: Number(Number(g.usd).toFixed(2)),
      })),
      lastExecution: latest.find(t => t.ticker === m.ticker) ?? null,
      historyCoverage: coverage.find(c => c.ticker === m.ticker) ?? { phase: "unknown", captureMinimum: null },
    })),
  };
}

export const gameAnalysisService = new GameAnalysisService({
  load: loadGameAnalysis, context: loadGameContext,
  async complete(context) {
    if (!analysisAvailable()) throw new AnalysisError("La integración de IA no está disponible en este entorno.", 503);
    const client = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      timeout: 90_000, maxRetries: 0,
    });
    try {
      const result = await client.chat.completions.create({
        model: ANALYSIS_MODEL, max_completion_tokens: 4000,
        messages: [{ role: "system", content: ANALYSIS_PROMPT },
          { role: "user", content: JSON.stringify(context) }],
      });
      if (result.choices[0]?.finish_reason === "length")
        throw new AnalysisError("La respuesta de IA quedó incompleta. El informe anterior se conserva.", 502);
      return result.choices[0]?.message.content ?? "";
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      // Do not expose SDK headers, credentials or raw upstream error bodies.
      throw new AnalysisError("No se pudo completar el análisis de IA. Comprueba la disponibilidad y los créditos e inténtalo de nuevo.", 502);
    }
  },
  async save(report) {
    const valid = AnalyzeKalshiGameResponse.parse(report);
    await db.insert(kalshiAnalysisTable).values({
      ticker: valid.ticker, report: valid, generatedAt: new Date(valid.generatedAt),
    }).onConflictDoUpdate({ target: kalshiAnalysisTable.ticker,
      set: { report: valid, generatedAt: new Date(valid.generatedAt) } });
  },
});
