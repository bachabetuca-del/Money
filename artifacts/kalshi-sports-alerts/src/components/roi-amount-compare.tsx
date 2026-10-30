import type { RoiLeaderboard } from '@workspace/api-client-react';
import { bandLeaders, MONEY_BAND_ORDER, MONEY_BANDS, NO_DATA, ratePct, rateTone, type MoneyBandKey } from '../lib/roi-breakdown';

/** Side-by-side observed accuracy/ROI for the three amount ranges in the amount view. Values come from server rows only. */
export function RoiAmountCompare({ data }: { data: Pick<RoiLeaderboard, 'rows' | 'minGames' | 'band'> }) {
  const items = MONEY_BAND_ORDER.map((band) => {
    const r = data.rows.find((x) => x.moneyBand === band);
    return { band, row: r, roiPct: r ? r.roiPct : null, winRatePct: r ? r.winRatePct : null, trades: r?.trades ?? 0 };
  });
  const leaders = bandLeaders(items);
  const name = (bs: MoneyBandKey[]) => bs.map((b) => MONEY_BANDS[b].short).join(' y ');
  return (
    <div className="lb-amt" data-testid="compare-amount-bands">
      <p className="lb-amt-lead" data-testid="text-amount-leaders">
        Mayor % de aciertos observado: <b>{leaders.winRate ? `${name(leaders.winRate.bands)} (${ratePct(leaders.winRate.value, false)})` : NO_DATA}</b>
        <span aria-hidden="true"> · </span>
        Mayor ROI observado: <b className={leaders.roi ? rateTone(leaders.roi.value) : ''}>{leaders.roi ? `${name(leaders.roi.bands)} (${ratePct(leaders.roi.value)})` : NO_DATA}</b>
      </p>
      <ul className="lb-amt-grid">
        {items.map(({ band, row }) => (
          <li key={band} className={row ? '' : 'empty'} data-testid={`card-amount-${band}`}>
            <span className="lb-amt-band">{MONEY_BANDS[band].short}</span>
            <small>{MONEY_BANDS[band].range}</small>
            {row ? <>
              <div className="lb-amt-nums">
                <div><em>% aciertos</em><b>{ratePct(row.winRatePct, false)}</b></div>
                <div><em>ROI</em><b className={rateTone(row.roiPct)}>{ratePct(row.roiPct)}</b></div>
              </div>
              <small>{row.wins}/{row.trades} ganadas · {row.games} partidos{row.sampleWarning ? ' · muestra pequeña' : ''}</small>
            </> : <p>{NO_DATA}{data.band !== 'all' ? ' · excluido por el filtro de banda' : ` · no alcanza ${data.minGames} ${data.minGames === 1 ? 'partido' : 'partidos'} o sin operaciones`}</p>}
          </li>
        ))}
      </ul>
      <p className="lb-foot">Comparación histórica con los filtros actuales. Ningún rango se presenta como fiable ni rentable en el futuro.</p>
    </div>
  );
}
