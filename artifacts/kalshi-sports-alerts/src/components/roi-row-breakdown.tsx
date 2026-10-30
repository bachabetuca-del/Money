import { AlertTriangle } from 'lucide-react';
import type { RoiMoneyPerformance, RoiRankingRow, RoiWeekPerformance } from '@workspace/api-client-react';
import { bandLeaders, MONEY_BAND_ORDER, MONEY_BANDS, NO_DATA, ratePct, rateTone, signedUsd, weekRange } from '../lib/roi-breakdown';

/** Weekly ROI and observed-transaction-size breakdown for one ranking row. Read-only disclosure; no re-ranking. */
export function RoiRowBreakdown({ row, minGames }: { row: RoiRankingRow; minGames?: number }) {
  const weeks = [...(row.weekly ?? [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const bands = MONEY_BAND_ORDER.map((b) => (row.moneyBands ?? []).find((m) => m.band === b) ?? null);
  const leaders = bandLeaders(bands.filter((b): b is RoiMoneyPerformance => b != null));
  return (
    <div className="lb-bd" data-testid={`breakdown-${row.id}`}>
      <section className="lb-bd-sec" aria-label="ROI semanal">
        <h4>ROI semanal <small>lunes–domingo, hora de Nueva York, por fecha de ejecución</small></h4>
        {weeks.length === 0 ? <p className="lb-bd-empty">{NO_DATA} semanales para esta fila.</p> : (
          <div className="lb-bd-scroll">
            <table className="lb-bd-table" data-testid={`table-weekly-${row.id}`}>
              <thead><tr><th scope="col">Semana</th><th scope="col" className="r">ROI</th><th scope="col" className="r">% aciertos</th><th scope="col" className="r">Ops.</th><th scope="col" className="r">Partidos</th></tr></thead>
              <tbody>{weeks.map((w) => <WeekRow key={w.weekStart} w={w} id={row.id} />)}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="lb-bd-sec" aria-label="Por tamaño de operación observada">
        <h4>Por tamaño de operación observada <small>importe de la operación vista, no tamaño de apuesta sugerido</small></h4>
        <div className="lb-bd-scroll">
          <table className="lb-bd-table" data-testid={`table-money-${row.id}`}>
            <thead><tr><th scope="col">Rango</th><th scope="col" className="r">ROI</th><th scope="col" className="r">% aciertos</th><th scope="col" className="r">Ops.</th><th scope="col" className="r">Partidos</th></tr></thead>
            <tbody>
              {MONEY_BAND_ORDER.map((b, i) => {
                const m = bands[i];
                const empty = !m || m.trades === 0;
                return (
                  <tr key={b} data-testid={`row-money-${row.id}-${b}`}>
                    <th scope="row">{MONEY_BANDS[b].short}<small>{MONEY_BANDS[b].range}</small></th>
                    {empty ? <td className="r none" colSpan={4}>{NO_DATA}</td> : <>
                      <td className={`r ${rateTone(m.roiPct)}`}>
                        {ratePct(m.roiPct)}{leaders.roi?.bands.includes(b) && leaders.roi.bands.length < 3 && <span className="lb-bd-flag">mayor ROI observado</span>}
                      </td>
                      <td className="r">
                        {ratePct(m.winRatePct, false)}{leaders.winRate?.bands.includes(b) && leaders.winRate.bands.length < 3 && <span className="lb-bd-flag">mayor % observado</span>}
                        <small>{m.wins}/{m.trades}</small>
                      </td>
                      <td className="r">{m.trades.toLocaleString('es-US')}<small className={rateTone(m.profit)}>{signedUsd(m.profit)}</small></td>
                      <td className="r">
                        {m.games.toLocaleString('es-US')}
                        {(m.sampleWarning || !m.meetsMinimum) && <span className="lb-bd-warn"><AlertTriangle size={11} aria-hidden="true" />{!m.meetsMinimum ? `bajo mínimo${minGames ? ` (${minGames})` : ''}` : 'muestra pequeña'}</span>}
                      </td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="lb-bd-note">
        Los partidos son identificadores distintos disponibles y pueden repetirse entre semanas y rangos: no se suman como partidos independientes.
        Una semana "parcial" está abierta o recortada por el periodo elegido; no certifica cobertura completa. Histórico, $100 iguales por operación antes de comisiones; no indica qué rango funcionará en el futuro.
      </p>
    </div>
  );
}

function WeekRow({ w, id }: { w: RoiWeekPerformance; id: string }) {
  const empty = w.trades === 0;
  return (
    <tr data-testid={`row-week-${id}-${w.weekStart}`}>
      <th scope="row">
        {weekRange(w.weekStart)}
        {(w.partial || (!empty && w.sampleWarning)) && <small>{[w.partial ? 'parcial' : null, !empty && w.sampleWarning ? 'muestra pequeña' : null].filter(Boolean).join(' · ')}</small>}
      </th>
      {empty ? <td className="r none" colSpan={4}>{NO_DATA}</td> : <>
        <td className={`r ${rateTone(w.roiPct)}`}>{ratePct(w.roiPct)}<small className={rateTone(w.profit)}>{signedUsd(w.profit)}</small></td>
        <td className="r">{ratePct(w.winRatePct, false)}<small>{w.wins}/{w.trades}</small></td>
        <td className="r">{w.trades.toLocaleString('es-US')}</td>
        <td className="r">{w.games.toLocaleString('es-US')}</td>
      </>}
    </tr>
  );
}
