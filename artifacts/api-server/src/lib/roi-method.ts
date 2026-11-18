import type { RoiMethodology, RoiPhase } from "@workspace/api-zod";
import type { RoiRollup } from "./roi-ranking";
import { marketType } from "./market-type";
import { ROI_STAKE } from "./roi-performance";

export const ROI_METHOD_VERSION = "first-game-pattern-phase-v1";
export type RoiUnit = "game" | "execution";
export type PhaseContext = {
  milestoneId?: string | null; startsAt?: Date | string | null;
  state?: string | null; source?: string | null; checkedAt?: Date | string | null;
  delayed?: boolean; error?: string | null;
};
export const ROI_PHASE_LABELS: Record<RoiPhase, string> = {
  prematch: "Prepartido · ≥10 min", nearStart: "Cerca del inicio · <10 min",
  live: "En vivo confirmado", unknown: "Fase desconocida",
};

/** Schedule is not actual kickoff. A past schedule alone NEVER proves live.
 * Only an observation of the live feed at/before the execution can do so. */
export function roiPhaseAt(at: Date | string, game?: PhaseContext | null): RoiPhase {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t) || !game?.milestoneId) return "unknown";
  const checked = game.checkedAt ? new Date(game.checkedAt).getTime() : NaN;
  const contemporaneous = Number.isFinite(checked) && checked <= t && t - checked <= 120_000 &&
    !game.delayed && !game.error;
  if (contemporaneous && game.state === "finished") return "unknown";
  if (contemporaneous && game.source === "live" && game.state === "live") return "live";
  const start = game.startsAt ? new Date(game.startsAt).getTime() : NaN;
  if (!Number.isFinite(start) || t >= start) return "unknown";
  return t <= start - 600_000 ? "prematch" : "nearStart";
}

/** Reduction happens BEFORE settlement filtering: never replace an unresolved,
 * unsupported or incomplete first selection with a later known winner. */
export function selectRoiEntries(
  rows: RoiRollup[], unit: RoiUnit = "game", phase: RoiPhase = "prematch",
): { rows: RoiRollup[]; methodology: RoiMethodology } {
  const rawExecutions = rows.reduce((s, r) => s + r.trades, 0);
  const matching = rows.filter(r => (r.phase ?? "unknown") === phase);
  const usable = matching.filter(r => r.identityVerified && r.inputValid && marketType(r) !== "other" &&
    marketType(r) !== "futures");
  const first = new Map<string, RoiRollup>();
  if (unit === "game") {
    for (const r of usable) {
      // Different price/money/phase rules are distinct patterns, but different
      // team selections, lines, tickers or weeks within a pattern are not.
      const key = JSON.stringify([r.gameId, r.sport, marketType(r), r.side, r.bucket, r.moneyBand, phase]);
      const prior = first.get(key);
      if (!r.firstTradeId || !Number.isFinite(r.firstPrice)) continue;
      if (!prior || r.firstAt < prior.firstAt ||
          (r.firstAt === prior.firstAt && r.firstTradeId < prior.firstTradeId!)) first.set(key, r);
    }
  }
  const selected = unit === "execution" ? matching : [...first.values()].map(r => {
    const settled = r.category === "settled";
    const win = settled && r.side === r.officialResult;
    const profit = settled ? win ? ROI_STAKE / r.firstPrice! - ROI_STAKE : -ROI_STAKE : 0;
    const recent = !!r.firstIsRecent;
    return { ...r, trades: 1, wins: win ? 1 : 0, profit,
      recentTrades: settled && recent ? 1 : 0, recentProfit: recent ? profit : 0,
      fees: r.firstFee ?? 0, feeTrades: r.firstFee == null ? 0 : 1,
      recentFees: recent ? r.firstFee ?? 0 : 0, recentFeeTrades: recent && r.firstFee != null ? 1 : 0,
      lastAt: r.firstAt,
    };
  });
  return { rows: selected, methodology: {
    version: ROI_METHOD_VERSION, unit, phase, rawExecutions,
    selectedEntries: selected.reduce((s, r) => s + r.trades, 0),
    repeatedExecutions: unit === "game" ? Math.max(0, usable.reduce((s, r) => s + r.trades, 0) - selected.length) : 0,
    unknownPhaseExecutions: rows.filter(r => !r.phase || r.phase === "unknown").reduce((s, r) => s + r.trades, 0),
    ambiguousIdentityExecutions: rows.filter(r => !r.identityVerified).reduce((s, r) => s + r.trades, 0),
    unclassifiedExecutions: rows.filter(r => ["other", "futures"].includes(marketType(r))).reduce((s, r) => s + r.trades, 0),
    description: unit === "game"
      ? "Primera entrada válida por partido × deporte × tipo × SÍ/NO × precio × monto × fase, dentro de la ventana elegida. Orden: ejecución UTC y luego ID. Se elige antes de filtrar el resultado. Solo identidad milestone; varias líneas/selecciones compiten por la primera entrada. Totales amplios suman patrones distintos, no una apuesta única por partido."
      : "Comparación secundaria: $100 por cada ejecución en la fase elegida; puede concentrarse en un mismo partido. No son participantes independientes.",
  } };
}
