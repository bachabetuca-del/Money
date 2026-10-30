import { AlertTriangle, ArrowDown } from 'lucide-react';
import type { RoiRankingRow } from '@workspace/api-client-react';
import { americanOddsRange, oddsBoundaryText, ROI_MARKET_NAMES, roiSportLabel } from '../lib/roi-display';

/** The server sorts and paginates these side-specific segments; do not re-rank a page locally. */
export function RoiCombinedTable({ rows }: { rows: RoiRankingRow[] }) {
  return (
    <>
      <div className="lb-table-wrap" role="region" aria-label="Ranking combinado; tabla desplazable" tabIndex={0}>
        <table className="ws-table lb-table lb-combined-table" data-testid="table-leaderboard">
          <caption className="sr-only">ROI hipotético por deporte, mercado, lado y rango de odds americanas, de mayor a menor ROI</caption>
          <thead>
            <tr>
              <th scope="col">Deporte</th>
              <th scope="col">Mercado</th>
              <th scope="col">Lado</th>
              <th scope="col">Odds americanas <span className="lb-approx">aprox.</span></th>
              <th scope="col" className="r">Aciertos</th>
              <th scope="col" className="r" aria-sort="descending"><span className="lb-sort">ROI <ArrowDown size={12} aria-hidden="true" /></span></th>
              <th scope="col" className="r">Muestras</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} data-testid={`row-leaderboard-${r.id}`}>
                <th scope="row" data-testid={`text-label-${r.id}`}>{roiSportLabel(r.sport)}</th>
                <td>{r.marketType ? ROI_MARKET_NAMES[r.marketType] ?? r.marketType : 'Sin clasificar'}</td>
                <td><span className={`lb-side ${r.side ?? ''}`} data-testid={`text-side-${r.id}`}>{r.side?.toUpperCase() ?? 'n/d'}</span></td>
                <td className="lb-american-odds" title={oddsBoundaryText(r.oddsMin, r.oddsMax)} data-testid={`text-odds-${r.id}`}>
                  {americanOddsRange(r.oddsMin, r.oddsMax)}
                </td>
                <td className="r" title={`${r.winRatePct.toFixed(1)}% de aciertos · ${r.losses} perdidas`} data-testid={`text-wins-${r.id}`}>
                  {r.wins.toLocaleString('es-US')}<span className="lb-fraction">/{r.trades.toLocaleString('es-US')}</span>
                </td>
                <td className={`r lb-roi ${r.roiPct > 0 ? 'pos' : r.roiPct < 0 ? 'neg' : ''}`} data-testid={`text-roi-${r.id}`}>
                  {r.roiPct > 0 ? '+' : ''}{r.roiPct.toFixed(1)}%
                </td>
                <td className="r" title={`${r.trades} operaciones · ${r.games} partidos estimados · ${r.markets} mercados`}>
                  <span className="lb-sample" data-testid={`text-samples-${r.id}`}>
                    {r.sampleWarning && <span className="lb-sample-warning" data-testid={`status-sample-${r.id}`} title="Muestra pequeña: menos de 10 partidos o 30 operaciones">
                      <AlertTriangle size={12} aria-hidden="true" /><span className="sr-only">Muestra pequeña. </span>
                    </span>}
                    {r.trades.toLocaleString('es-US')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lb-table-note">
        <span>Aciertos = ganadas / total. Muestras = operaciones liquidadas, no partidos independientes.</span>
        {rows.some(r => r.sampleWarning) && <span className="lb-sample-legend"><AlertTriangle size={12} aria-hidden="true" /> Muestra pequeña</span>}
        <span className="lb-scroll-hint">Desliza para ver todas las columnas.</span>
      </div>
    </>
  );
}
