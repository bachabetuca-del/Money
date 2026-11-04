import type { ExplorerMarketRoi, ExplorerRoiSignal, RoiFeeModel } from '@workspace/api-client-react';
import { americanOddsRange, oddsBoundaryText } from '@/lib/roi-display';
import { RoiFeeMethodology, RoiNetValue } from './roi-costs';
import './explorer-roi.css';

export type RoiView = {
  market?: ExplorerMarketRoi;
  loading: boolean;
  error: boolean;
  historyAsOf?: string;
  feeModel?: RoiFeeModel;
};
type Direction = 'all' | 'yes' | 'no';
const reasons = {
  no_price: 'Sin precio observado',
  no_history: 'Sin histórico comparable',
  small_sample: 'Muestra insuficiente',
  unclassified: 'Tipo sin clasificar',
};
const levels = { good: 'Alto', medium: 'Medio', bad: 'Negativo', insufficient: 'Sin base suficiente' };
const pct = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('es-US', { maximumFractionDigits: 2 })}%`;
const sideLabel = (side: 'yes' | 'no') => side === 'yes' ? 'SÍ' : 'NO';
const sidesFor = (direction: Direction): ('yes' | 'no')[] => direction === 'all' ? ['yes', 'no'] : [direction];
function timeLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'sin fecha';
  return new Intl.DateTimeFormat('es-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value)) + ' ET';
}
function presentation(view: RoiView, signal?: ExplorerRoiSignal) {
  if (view.error) return { level: 'insufficient', text: 'Sin actualizar', title: 'No se pudo actualizar el ROI. No se asigna color con datos desactualizados.' };
  if (view.loading) return { level: 'insufficient', text: 'Cargando', title: 'Cargando el histórico verificado, sin bloquear las gráficas.' };
  if (!signal) return { level: 'insufficient', text: 'Sin referencia', title: 'Todavía no hay una referencia para este mercado. Se revisa cada minuto.' };
  const reason = signal.reason ? reasons[signal.reason] : null;
  const text = signal.roiPct === null ? reason ?? 'Sin datos' : pct(signal.roiPct);
  return {
    level: signal.level,
    text: signal.level === 'insufficient' && signal.roiPct !== null ? `${text} · muestra baja` : text,
    title: [
      `ROI bruto histórico ${reason ?? levels[signal.level]}. Neto estimado: ${signal.net.roiPct === null ? 'no disponible' : pct(signal.net.roiPct)}.`,
      `${signal.games} partidos distintos · ${signal.trades} operaciones.`,
      `Odds americanas aprox.: ${americanOddsRange(signal.oddsMin, signal.oddsMax)}.`,
      oddsBoundaryText(signal.oddsMin, signal.oddsMax),
      `Precio de una operación guardada el ${timeLabel(signal.observedAt)}, no cotización en vivo.`,
    ].join(' '),
  };
}

/** Both directions remain separate; never paint a market green from its best side. */
export function MarketRoiBadges({ view, direction }: { view: RoiView; direction: Direction }) {
  return <span className="mr-badges" aria-label="ROI histórico comparable">
    {sidesFor(direction).map(side => {
      const signal = view.market?.signals.find(s => s.side === side);
      const p = presentation(view, signal);
      return <span key={side} className={`mr-badge mr-${p.level}`} title={p.title} data-roi-side={side} data-roi-level={p.level}>
        <i aria-hidden="true" />{sideLabel(side)} · ROI bruto {p.text}
      </span>;
    })}
  </span>;
}

export function RoiColorLegend({ minimumGames = 50, minimumTrades = 30, greenMin = 10 }: {
  minimumGames?: number; minimumTrades?: number; greenMin?: number;
}) {
  return <section className="mr-legend" aria-label="Leyenda de colores ROI" data-testid="roi-color-legend">
    <strong>Colores · ROI bruto histórico</strong>
    <div className="mr-key">
      <span className="mr-badge mr-good"><i aria-hidden="true" />Verde · ≥ +{greenMin}%</span>
      <span className="mr-badge mr-medium"><i aria-hidden="true" />Amarillo · 0% a &lt; +{greenMin}%</span>
      <span className="mr-badge mr-bad"><i aria-hidden="true" />Rojo · &lt; 0%</span>
      <span className="mr-badge mr-insufficient"><i aria-hidden="true" />Gris · sin base suficiente</span>
    </div>
    <details>
      <summary>Cómo se asignan los colores</summary>
      <p>Se compara el mismo deporte, tipo de apuesta, lado SÍ/NO, rango de odds y banda de dinero.
        Se necesitan al menos {minimumGames} partidos distintos y {minimumTrades} operaciones con histórico verificado y resolución oficial.</p>
      <p>El rango de odds se toma de la última operación guardada de cada lado y banda, no de una cotización en vivo.
        Se usa todo el histórico verificado; el filtro de 1 h / 24 h afecta a la gráfica, no a esta comparación.</p>
      <p>Los colores son rangos visuales de ROI simulado con $100 por operación, antes de comisiones.
        No representan el resultado del partido actual, una probabilidad de ganar ni una recomendación de apuesta.</p>
    </details>
  </section>;
}

export function MarketRoiDetail({ view, direction }: { view: RoiView; direction: Direction }) {
  return <section className="mr-detail" aria-label="Contexto ROI del mercado" data-testid="market-roi-context">
    <h3>ROI histórico comparable</h3>
    <MarketRoiBadges view={view} direction={direction} />
    {!view.loading && !view.error && <div className="mr-samples">
      {sidesFor(direction).map(side => {
        const s = view.market?.signals.find(signal => signal.side === side);
        if (!s) return null;
        return <div key={side}>
          <b>{sideLabel(side)}</b>
          <span>Bruto: {s.roiPct === null ? 'no disponible' : pct(s.roiPct)} · Neto estimado: <RoiNetValue net={s.net} /></span>
          <span>{s.games.toLocaleString('es-US')} partidos · {s.trades.toLocaleString('es-US')} operaciones</span>
          {s.price !== null && <>
            <span>Odds del grupo: {americanOddsRange(s.oddsMin, s.oddsMax)} <span className="mr-boundary">({oddsBoundaryText(s.oddsMin, s.oddsMax)})</span></span>
            <span className="mr-reference">Última operación de este lado y banda: {(s.price * 100).toLocaleString('es-US', { maximumFractionDigits: 2 })}¢ · {timeLabel(s.observedAt)}</span>
          </>}
          {s.reason && <span className="mr-reason">{reasons[s.reason]}</span>}
        </div>;
      })}
    </div>}
    <p>Mismo deporte, tipo, lado, odds y banda de dinero. Histórico completo verificado;
      no es el ROI de este partido ni una predicción. $100 simulados por operación; bruto antes de comisiones y neto después de la comisión estimada. Los colores siguen usando el bruto.</p>
    <RoiFeeMethodology model={view.feeModel} />
    {view.historyAsOf && <p className="mr-asof">Histórico calculado: {timeLabel(view.historyAsOf)} · actualización cada minuto</p>}
  </section>;
}
