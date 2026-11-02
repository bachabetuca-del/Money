import { db, kalshiSignalEvaluationTable as evaluation, kalshiMonitorSettingsTable as settings } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { SignalEvaluation, SignalPerformance } from "@workspace/api-zod";
import { signalOutcome } from "./signal-evaluation";
import { signalEvidenceSchema } from "./signal-evidence-schema";
import type { NotificationDatabase } from "./telegram-trade-notification-store";

/** Runtime-only initialization, after the existing bot ownership lock. No
 * migration default/GET handler creates a start date or backfills membership. */
export async function activateSignalEvaluation(executor: NotificationDatabase = db) {
  await executor.insert(evaluation).values({ id: 1 }).onConflictDoNothing();
}

const LIMITATIONS = [
  "Evaluación prospectiva: solo señales nuevas elegibles desde la activación. El ROI histórico que seleccionó cada señal es retrospectivo y permanece congelado; no es su resultado posterior.",
  "Simulación de $100 de entrada por señal, con cantidad teórica 100/precio y hasta la liquidación oficial binaria. No son operaciones ejecutadas, recomendaciones de monto ni beneficios del operador observado.",
  "El precio observado pertenece a una ejecución pública anterior al aviso. No demuestra que pudiera comprarse a ese precio al recibirlo: no se comprueba liquidez, latencia, spread ni deslizamiento.",
  "El neto conserva la tarifa y el modelo disponibles al registrar cada señal. No sustituye los costes reales; si falta alguna tarifa no se calcula un neto agregado con una muestra distinta.",
  "Solo los avisos con entrega confirmada y una liquidación final verificada después entran en el rendimiento. Avisos sin entregar, errores, pendientes y liquidaciones no soportadas no cuentan como pérdidas.",
  "La fecha de liquidación mostrada es la verificación guardada por el monitor, no la hora exacta del pago en Kalshi. Puede existir demora en la consulta oficial o en la entrega de Telegram.",
  "Varias señales del mismo partido están correlacionadas. Los partidos distintos usan la identidad disponible al registrar (milestone, evento o ticker aproximado), no representan apuestas independientes.",
  "Se evalúa solo lo observado por este monitor, con posibles interrupciones y selección por reglas cambiantes. Una muestra pequeña, e incluso un ROI positivo posterior, no demuestra rentabilidad futura.",
];
const date = (value: unknown): Date | null => value == null ? null : new Date(value as string | Date);
const iso = (value: unknown) => date(value)?.toISOString() ?? null;

/** Both summaries and paged rows share the identical settlement eligibility.
 * No trade/history/fee-catalog join: ONLY immutable evidence and delivery/result. */
function projection(now: Date) {
  return sql`
    WITH base AS (
      SELECT s.trade_id, s.chat_id, s.game_id, s.captured_at, s.evidence,
        n.sent_at, n.skipped_at, coalesce(n.attempts, 0) AS attempts,
        m.result, m.terminal, m.checked_at, m.error,
        s.evidence->'rule'->>'version' AS rule_version,
        s.evidence->'rule'->>'basis' AS basis,
        s.evidence->'feeModel'->>'version' AS fee_model_version,
        s.evidence->'rule'->>'side' AS side,
        (s.evidence->'rule'->>'stakeUsd')::numeric AS stake,
        (s.evidence->>'price')::numeric AS price,
        (s.evidence->>'entryFeeUsd')::numeric AS fee
      FROM kalshi_signals s
      JOIN kalshi_signal_evaluation e ON e.id = s.evaluation_id
      LEFT JOIN kalshi_notifications n ON n.chat_id = s.chat_id AND n.trade_id = s.trade_id
      LEFT JOIN kalshi_market_settlements m ON m.ticker = s.ticker AND m.checked_at <= ${now}
      WHERE s.captured_at >= e.activated_at AND s.captured_at <= ${now}
    ), classified AS (
      SELECT *, CASE WHEN sent_at IS NULL THEN 'not_sent'
        WHEN terminal = true AND checked_at IS NOT NULL AND error IS NULL THEN
          CASE WHEN checked_at <= sent_at OR coalesce(result, '') NOT IN ('yes', 'no')
            THEN 'excluded' ELSE 'settled' END
        ELSE 'pending' END AS status
      FROM base
    ), performance AS (
      SELECT *, CASE WHEN status = 'settled'
        THEN CASE WHEN side = result THEN stake / price - stake ELSE -stake END
        ELSE NULL END AS profit
      FROM classified
    )
  `;
}

function performance(row: Record<string, unknown>): SignalPerformance {
  const n = (key: string) => Number(row[key] ?? 0);
  const settled = n("settled"), invested = n("invested"), feeCovered = n("fee_covered");
  const grossProfit = settled ? n("profit") : null;
  const fees = n("fees"), netAvailable = settled > 0 && feeCovered === settled;
  const netProfit = netAvailable ? grossProfit! - fees : null;
  const netOutlay = netAvailable ? invested + fees : null;
  return {
    registered: n("registered"), delivered: n("delivered"), awaitingDelivery: n("awaiting_delivery"),
    skipped: n("skipped"), settled, pending: n("pending"), excluded: n("excluded"),
    games: n("games"), settledGames: n("settled_games"), wins: n("wins"), losses: settled - n("wins"),
    grossProfit, grossRoiPct: grossProfit === null ? null : 100 * grossProfit / invested,
    invested, netProfit, netOutlay, netRoiPct: netProfit === null ? null : 100 * netProfit / netOutlay!,
    feeCovered, feeMissing: settled - feeCovered,
  };
}

export async function loadSignalEvaluation(
  requestedPage: number, now: Date, executor: NotificationDatabase = db,
  workersEnabled = process.env.BOT_WORKERS_ENABLED !== "false",
): Promise<SignalEvaluation> {
  const [config] = await executor.select().from(evaluation).where(eq(evaluation.id, 1)).limit(1);
  const [monitor] = await executor.select({ enabled: settings.enabled }).from(settings).where(eq(settings.id, 1)).limit(1);
  const totals = await executor.execute(sql`${projection(now)}
    SELECT rule_version, basis, fee_model_version, grouping(rule_version) AS is_summary,
      count(*)::int AS registered,
      count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS delivered,
      count(*) FILTER (WHERE sent_at IS NULL AND skipped_at IS NULL)::int AS awaiting_delivery,
      count(*) FILTER (WHERE sent_at IS NULL AND skipped_at IS NOT NULL)::int AS skipped,
      count(*) FILTER (WHERE status = 'settled')::int AS settled,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'excluded')::int AS excluded,
      count(DISTINCT game_id) FILTER (WHERE sent_at IS NOT NULL)::int AS games,
      count(DISTINCT game_id) FILTER (WHERE status = 'settled')::int AS settled_games,
      count(*) FILTER (WHERE status = 'settled' AND side = result)::int AS wins,
      sum(profit)::float8 AS profit,
      coalesce(sum(stake) FILTER (WHERE status = 'settled'), 0)::float8 AS invested,
      count(fee) FILTER (WHERE status = 'settled')::int AS fee_covered,
      sum(fee) FILTER (WHERE status = 'settled')::float8 AS fees,
      min(captured_at) AS first_at, max(captured_at) AS last_at, max(checked_at) AS checked_at
    FROM performance
    GROUP BY GROUPING SETS ((), (rule_version, basis, fee_model_version))
    ORDER BY rule_version NULLS FIRST, basis, fee_model_version
  `);
  const total = totals.rows.find(row => Number(row.is_summary) === 1) ?? {};
  const summary = performance(total), pageSize = 25;
  const totalPages = Math.ceil(summary.registered / pageSize);
  const page = Math.max(1, Math.min(requestedPage, totalPages || 1));
  const records = await executor.execute(sql`${projection(now)}
    SELECT * FROM performance ORDER BY captured_at DESC, trade_id, chat_id
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);
  return {
    generatedAt: now.toISOString(), activatedAt: config?.activatedAt.toISOString() ?? null,
    recording: !config ? "not_started" : workersEnabled && monitor?.enabled ? "active" : "paused",
    firstSignalAt: iso(total.first_at), lastSignalAt: iso(total.last_at), lastSettlementCheckAt: iso(total.checked_at),
    summary, cohorts: totals.rows.filter(row => Number(row.is_summary) === 0).map(row => ({
      ruleVersion: String(row.rule_version), basis: row.basis as "gross" | "net",
      feeModelVersion: String(row.fee_model_version), performance: performance(row),
    })),
    limitations: LIMITATIONS, page, pageSize, totalPages,
    rows: records.rows.map(row => signalOutcome(signalEvidenceSchema.parse(row.evidence), {
      sentAt: date(row.sent_at), skippedAt: date(row.skipped_at), attempts: Number(row.attempts),
      result: row.result as string | null, terminal: row.terminal as boolean | null,
      checkedAt: date(row.checked_at), error: row.error as string | null,
    })),
  };
}

export function getSignalEvaluation(page = 1, now = new Date()) {
  return db.transaction(tx => loadSignalEvaluation(page, now, tx), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}
