import { and, eq, inArray } from "drizzle-orm";
import { db, kalshiSignalsTable as signals, kalshiNotificationsTable as notifications,
  kalshiAlertsTable as alerts, kalshiSettlementsTable as settlements } from "@workspace/db";
import type { PaperAudit, PaperAuditRow } from "@workspace/api-zod";
import { signalEvidenceSchema } from "../signal-evidence-schema";
import { AUDITED_SIGNALS, type AuditedSignal } from "./audit-sample";
import { hypotheticalProfit } from "../roi-ranking";
import { estimateHypotheticalEntryFee } from "../kalshi-fees";

const seconds = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
export function auditedRow(s: AuditedSignal): PaperAuditRow {
  return {
    tradeId: s.tradeId, eventTitle: s.eventTitle, side: s.side, price: s.price, publicAmountUsd: s.notional,
    observedAt: s.observed, queuedAt: s.queued, capturedAt: s.decided, confirmedAt: s.confirmed,
    exchangeToQueueSeconds: seconds(s.observed, s.queued),
    queueToDecisionSeconds: seconds(s.queued, s.decided), decisionToConfirmSeconds: seconds(s.decided, s.confirmed),
    totalSeconds: seconds(s.observed, s.confirmed), attempts: 0, historicalGames: s.games,
    historicalTrades: s.trades, frozenRoiPct: s.roi, entryFeeUsd: s.fee, result: s.result,
    hypotheticalGrossProfitUsd: hypotheticalProfit(s.price, s.side, s.result ?? ""),
    notes: [
      "Muestra real conciliada en producción el 17 nov 2026; no se inscribe en la nueva prueba.",
      `Primera persistencia: ${s.saved}; ${seconds(s.observed, s.saved).toFixed(3)} s después de la operación. No es una medición de recepción WebSocket.`,
      `${seconds(s.saved, s.queued).toFixed(3)} s entre guardado y cola.`,
      `Compra hipotética de $100: ${ (100 / s.price).toFixed(6) } contratos teóricos, más $${s.fee.toFixed(4)} de comisión congelada.`,
      "Cola→decisión incluye espera y evaluación; faltan tiempos separados de recepción, inicio de consulta y comienzo del envío.",
      "Resultado binario del mercado, no score. Confirmación del servidor no demuestra entrega o lectura en el teléfono.",
    ],
  };
}
export async function paperAudit(now = new Date()): Promise<PaperAudit> {
  // Six primary-key lookups, never a historical backtest or a broad production scan.
  const saved = await db.select({ tradeId: signals.tradeId, evidence: signals.evidence,
    sentAt: notifications.sentAt, attempts: notifications.attempts, result: settlements.result,
    terminal: settlements.terminal, error: settlements.error })
    .from(signals).innerJoin(notifications, and(eq(notifications.tradeId, signals.tradeId), eq(notifications.chatId, signals.chatId)))
    .leftJoin(settlements, eq(settlements.ticker, signals.ticker))
    .where(inArray(signals.tradeId, AUDITED_SIGNALS.map(s => s.tradeId))).limit(12);
  const rows = AUDITED_SIGNALS.map(s => {
    const row = auditedRow(s), live = saved.find(r => r.tradeId === s.tradeId);
    if (!live) {
      row.notes.push("No existe este aviso en la base de este entorno: se muestra la muestra auditada, no una consulta actual a producción.");
      return row;
    }
    const parsed = signalEvidenceSchema.safeParse(live.evidence);
    if (!parsed.success) {
      row.notes.push("La evidencia actual no pasó su validación; se conserva la copia auditada, sin reconstrucción.");
      return row;
    }
    const e = parsed.data;
    row.frozenRoiPct = e.historicalRoiPct; row.historicalGames = e.historicalGames;
    row.historicalTrades = e.historicalTrades; row.entryFeeUsd = e.entryFeeUsd; row.attempts = live.attempts;
    row.result = live.terminal && !live.error && ["yes", "no"].includes(live.result ?? "") ? live.result : null;
    row.hypotheticalGrossProfitUsd = hypotheticalProfit(e.price, e.rule.side, row.result ?? "");
    const recalculatedFee = estimateHypotheticalEntryFee(e.price, e.feeType && e.feeMultiplier !== null ?
      { feeType: e.feeType, multiplier: e.feeMultiplier } : null, e.rule.stakeUsd);
    row.notes.push(recalculatedFee === e.entryFeeUsd ?
      "La comisión congelada coincide con la fórmula y tarifa guardadas." : "Comisión sin conciliación exacta: revisar tarifa/evidencia original.");
    row.notes.push(`Historial que originó el aviso: ${e.historyAsOf}. No se reemplaza por el ranking de hoy.`);
    return row;
  });
  const stake = 37900, grossRoi = 61.42075827822088, netRoi = 52.411793668538174;
  const gross = stake * grossRoi / 100, fees = (gross - stake * netRoi / 100) / (1 + netRoi / 100);
  return { generatedAt: now.toISOString(),
    environment: process.env.NODE_ENV === "production" ? "Versión publicada · consulta de este entorno" :
      "Desarrollo · muestra auditada de producción separada de los datos locales",
    screenshotStatus: "Aviso identificado: Wales vs Portugal, SÍ a 15¢, $1.462,50. Demora total medida: 29 min 7,395 s.",
    screenshotArithmetic: { operaciones: 379, partidos: 100, compraHipoteticaUsd: stake,
      beneficioBrutoImplicitoUsd: gross, comisionesImplicitasUsd: fees,
      beneficioNetoImplicitoUsd: gross - fees, desembolsoConComisionesUsd: stake + fees,
      roiBrutoPct: grossRoi, roiNetoPct: netRoi, contratosPublicos: 9750, precioPublicoUsd: .15,
      montoPublicoUsd: 1462.5, comisionHipoteticaDeEstaEntradaUsd: 5.95 },
    notes: [
      "Los registros ya confirman la operación de la captura: 9.750 × $0,15 = $1.462,50; 100 partidos y 379 operaciones coinciden con la evidencia congelada.",
      "16 min 13,372 s hasta el primer guardado; 0,545 s hasta la cola; 12 min 52,743 s hasta congelar la decisión; 0,735 s hasta confirmar el envío.",
      "No se registró ningún reintento de ese aviso. Los timeouts observados en otros servicios no prueban la causa de su retraso.",
      "Los $23.278,47 brutos y $2.240,25 de comisiones son una comprobación algebraica de los porcentajes exactos guardados, no una conciliación de 379 fills reales.",
      "No se guardaron los 379 registros históricos que integraron aquella instantánea. No es posible reconstruir exactamente sus correcciones futuras con el historial actual.",
      "El ROI histórico usa $100 por operación al precio público del lado observado. Ganadora: 100/precio−100; perdedora: −100. Neto: (beneficio bruto−comisiones)/(compra+comisiones).",
      "La muestra SÍ/NO contiene operaciones repetidas del mismo partido; no son pruebas independientes. Wales SÍ terminó NO: la simulación original perdió $100 más $5,95 de comisión, pese al ROI histórico positivo.",
      "El precio público no es una oferta disponible tras la alerta. Esa diferencia es precisamente lo que medirá la nueva prueba prospectiva.",
    ], rows };
}
