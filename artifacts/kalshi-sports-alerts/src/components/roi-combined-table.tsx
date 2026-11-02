import { Fragment, useState } from 'react';
import { AlertTriangle, ArrowDown, ChevronRight } from 'lucide-react';
import type { RoiRankingRow } from '@workspace/api-client-react';
import { americanOddsRange, oddsBoundaryText, ROI_MARKET_NAMES, roiSportLabel } from '../lib/roi-display';
import { RoiRowBreakdown } from './roi-row-breakdown';
import { domId } from '../lib/roi-breakdown';
import { RoiNetValue } from './roi-costs';

type Sort = 'roi' | 'netRoi' | 'winRate';

/** The server sorts and paginates these side-specific segments; do not re-rank a page locally. */
export function RoiCombinedTable({ rows, sortBy = 'roi', minGames }: { rows: RoiRankingRow[]; sortBy?: Sort; minGames?: number }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="lb-table-wrap" role="region" aria-label="Ranking combinado; tabla desplazable" tabIndex={0}>
        <table className="ws-table lb-table lb-combined-table" data-testid="table-leaderboard">
          <caption className="sr-only">ROI hipotético por deporte, mercado, lado y rango de odds americanas, de mayor a menor {sortBy === 'winRate' ? 'porcentaje de aciertos' : 'ROI'}</caption>
          <thead>
            <tr>
              <th scope="col">Deporte</th>
              <th scope="col">Mercado</th>
              <th scope="col">Lado</th>
              <th scope="col">Odds americanas <span className="lb-approx">aprox.</span></th>
              <th scope="col" className="r" aria-sort={sortBy === 'winRate' ? 'descending' : undefined}><span className="lb-sort">Aciertos{sortBy === 'winRate' && <ArrowDown size={12} aria-hidden="true" />}</span></th>
               <th scope="col" className="r" aria-sort={sortBy === 'roi' ? 'descending' : undefined}><span className="lb-sort">ROI bruto{sortBy === 'roi' && <ArrowDown size={12} aria-hidden="true" />}</span></th>
               <th scope="col" className="r" aria-sort={sortBy === 'netRoi' ? 'descending' : undefined}><span className="lb-sort">ROI neto est.{sortBy === 'netRoi' && <ArrowDown size={12} aria-hidden="true" />}</span></th>
              <th scope="col" className="r">Muestras</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isOpen = open.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr data-testid={`row-leaderboard-${r.id}`} className={isOpen ? 'lb-open' : ''}>
                    <th scope="row">
                      <button type="button" className="lb-expand" aria-expanded={isOpen} aria-controls={domId('lb-detail', r.id)} onClick={() => toggle(r.id)} data-testid={`button-breakdown-${r.id}`}>
                        <ChevronRight size={13} aria-hidden="true" className={isOpen ? 'open' : ''} />
                        <span data-testid={`text-label-${r.id}`}>{roiSportLabel(r.sport)}</span>
                        <span className="sr-only"> · ver semanas y rangos de importe</span>
                      </button>
                    </th>
                    <td>{r.marketType ? ROI_MARKET_NAMES[r.marketType] ?? r.marketType : 'Sin clasificar'}</td>
                    <td><span className={`lb-side ${r.side ?? ''}`} data-testid={`text-side-${r.id}`}>{r.side?.toUpperCase() ?? 'n/d'}</span></td>
                    <td className="lb-american-odds" title={oddsBoundaryText(r.oddsMin, r.oddsMax)} data-testid={`text-odds-${r.id}`}>
                      {americanOddsRange(r.oddsMin, r.oddsMax)}
                    </td>
                    <td className="r" data-testid={`text-wins-${r.id}`}>
                      <span className="lb-pct" data-testid={`text-winrate-${r.id}`}>{r.winRatePct.toFixed(1)}%</span>
                      <span className="lb-cell-sub">{r.wins.toLocaleString('es-US')}<span className="lb-fraction">/{r.trades.toLocaleString('es-US')}</span></span>
                    </td>
                    <td className={`r lb-roi ${r.roiPct > 0 ? 'pos' : r.roiPct < 0 ? 'neg' : ''}`} data-testid={`text-roi-${r.id}`}>
                      {r.roiPct > 0 ? '+' : ''}{r.roiPct.toFixed(1)}%
                    </td>
                     <td className="r lb-roi" data-testid={`text-net-roi-${r.id}`}><RoiNetValue net={r.net} /></td>
                    <td className="r">
                      <span className="lb-sample" data-testid={`text-samples-${r.id}`}>
                        {r.sampleWarning && <span className="lb-sample-warning" data-testid={`status-sample-${r.id}`} title="Muestra pequeña: menos de 10 partidos o 30 operaciones">
                          <AlertTriangle size={12} aria-hidden="true" /><span className="sr-only">Muestra pequeña. </span>
                        </span>}
                        {r.trades.toLocaleString('es-US')} op.
                      </span>
                      <span className="lb-cell-sub" data-testid={`text-games-${r.id}`}>{r.games.toLocaleString('es-US')} {r.games === 1 ? 'partido' : 'partidos'}</span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="lb-detail-row" id={domId('lb-detail', r.id)}>
                       <td colSpan={8}><RoiRowBreakdown row={r} minGames={minGames} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="lb-table-note">
        <span>Bruto y neto usan las mismas muestras. Aciertos = % y ganadas / total. Muestras = operaciones liquidadas y partidos distintos, no partidos independientes. Toca el deporte para ver ROI semanal y rangos de importe.</span>
        {rows.some(r => r.sampleWarning) && <span className="lb-sample-legend"><AlertTriangle size={12} aria-hidden="true" /> Muestra pequeña</span>}
        <span className="lb-scroll-hint">Desliza para ver todas las columnas.</span>
      </div>
    </>
  );
}
