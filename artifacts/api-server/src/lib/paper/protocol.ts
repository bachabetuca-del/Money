import type { PaperProtocol, PaperProtocolInput, PaperRun } from "@workspace/api-zod";
import { SIGNAL_RULE_VERSION } from "../signal-evaluation";
import { NOTIFICATION_MIN_ROI_PCT, type RoiBasis } from "../telegram-notification-roi";
import { ROI_COLOR_POLICY } from "../explorer-roi";

export const PAPER_VERSION = "book-forward-v1";
export const PAPER_MAX_CANDIDATES = 10_000;
export const PAPER_MAX_QUEUE = 256;
export const PAPER_LIMITATIONS = [
  "Solo observamos candidatos que el monitor guardó y evaluó para Telegram; no todo Kalshi ni todas las apuestas posibles.",
  "No se envían órdenes. La confirmación de Telegram no demuestra llegada ni lectura en el teléfono; el retraso es un supuesto.",
  "Un dato desconocido no es una pérdida ni falta de liquidez. El ROI usa solo entradas cubiertas y liquidaciones binarias oficiales.",
  "Los intervalos agrupan partidos (800 remuestreos); se omiten con menos de 10 bloques. Mirarlos repetidamente no valida una estrategia.",
  "Los controles exigen identidad inequívoca del partido, fase conocida, deporte/tipo/lado/banda iguales, precio ±1¢, tiempo ±5 min y profundidad comparable.",
  "No se dispone de marcador ni tiempo restante contemporáneos; en vivo los controles se excluyen de la comparación causal por esa limitación.",
  "Se guardan hasta 20 niveles por lado, 10.000 candidatos por prueba y una cola de 256 observaciones. Al llegar al límite se detiene la captación.",
  "No se restaura liquidez consumida ficticiamente sin prueba de reposición. Este modelo conservador puede subestimar oportunidades repetidas.",
  "El período final se reserva por partido y sus resultados permanecen ocultos hasta el cierre fijado. Una pausa no adelanta ese cierre.",
  "No se certifica una ventaja con solo ROI positivo o 50 partidos. Controles, cobertura y riesgo de selección siguen siendo necesarios.",
];
export const PAPER_ASSUMPTIONS = [
  "Compra taker simulada; presupuesto de compra antes de comisiones. Contratos enteros, conservador incluso si el mercado admite fracciones.",
  "Comisión conocida al decidir, redondeada por nivel y conservada; no incluye impuestos, financiación, intermediarios ni rebates.",
  "Mismo presupuesto, exposición y capital independiente en cada escenario de retraso y política de repeticiones.",
  "Escenarios auxiliares 0 y 60 segundos; el retraso principal se fija antes de iniciar y no se selecciona después por su ROI.",
  "Primera alerta significa primera confirmada del partido, aunque no se pueda ejecutar. Repeticiones se analizan en un libro ficticio separado.",
  "Controles: candidatos con muestra suficiente descartados por ROI, referencia sintética de confirmación 1 segundo después de decidir; se comparan solo con alertas cuyo envío tardó 0–2 segundos.",
  "Emparejamiento cronológico sin reemplazo antes del resultado; no se emparejan mercados del mismo partido. Sin marcador/reloj en vivo no se afirma comparabilidad.",
  "Capacidad 10.000 candidatos por prueba. Una cola perdida/reinicio deja entradas desconocidas; nunca se reconstruyen precios anteriores con datos posteriores.",
];
export class PaperError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function makeProtocol(input: PaperProtocolInput, basis: RoiBasis): PaperProtocol {
  if (!input.name.trim()) throw new PaperError("Escribe un nombre para la prueba.", 400);
  if (input.holdoutDays >= input.runDays) throw new PaperError("El tramo final debe durar menos que la prueba.", 400);
  if (input.capitalUsd < input.maxGameUsd || input.maxGameUsd < input.stakeUsd)
    throw new PaperError("El capital debe cubrir la exposición por partido, y esta debe cubrir la compra.", 400);
  return { ...input, name: input.name.trim(), version: PAPER_VERSION, ruleVersion: SIGNAL_RULE_VERSION,
    basis, minimumRoiPct: NOTIFICATION_MIN_ROI_PCT,
    minimumGames: ROI_COLOR_POLICY.minimumGames, minimumTrades: ROI_COLOR_POLICY.minimumTrades,
    assumptions: PAPER_ASSUMPTIONS };
}
export const delays = (run: PaperRun) => [...new Set([0, run.protocol.delaySeconds, 60])].sort((a, b) => a - b);
export const hideHoldout = (run: PaperRun, now: Date) => !!run.endsAt && now.getTime() < Date.parse(run.endsAt);
