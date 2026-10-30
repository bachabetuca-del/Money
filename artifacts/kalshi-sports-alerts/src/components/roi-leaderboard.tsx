import { Fragment, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Scale, Trophy } from 'lucide-react';
import {
  getGetKalshiLeaderboardQueryKey,
  useGetKalshiLeaderboard,
  type GetKalshiLeaderboardBand,
  type GetKalshiLeaderboardCoverage,
  type GetKalshiLeaderboardDirection,
  type GetKalshiLeaderboardGroupBy,
  type GetKalshiLeaderboardParams,
  type GetKalshiLeaderboardSortBy,
  type RoiLeaderboard as RoiLeaderboardData,
  type GetKalshiLeaderboardWindow,
  type RoiCoverage,
  type RoiRankingRow,
} from '@workspace/api-client-react';
import { errorText } from '@/components/history-export';
import { RoiCombinedTable } from './roi-combined-table';
import { americanOddsRange, ROI_MARKET_NAMES } from '../lib/roi-display';
import { RoiRowBreakdown } from './roi-row-breakdown';
import { RoiAmountCompare } from './roi-amount-compare';
import { bandLabel, domId } from '../lib/roi-breakdown';
import './roi-leaderboard.css';

const TZ = 'America/New_York';
const GROUPS: { v: GetKalshiLeaderboardGroupBy; l: string }[] = [
  { v: 'segment', l: 'Ranking combinado' },
  { v: 'sport', l: 'Deportes' },
  { v: 'marketType', l: 'Tipos de mercado' },
  { v: 'odds', l: 'Rangos de cuota' },
  { v: 'market', l: 'Mercados individuales' },
  { v: 'amount', l: 'Rangos de importe' },
];
const SORTS: { v: GetKalshiLeaderboardSortBy; l: string }[] = [
  { v: 'roi', l: 'ROI' }, { v: 'winRate', l: '% aciertos' },
];
const WINDOWS: { v: GetKalshiLeaderboardWindow; l: string }[] = [
  { v: 'all', l: 'Todo' }, { v: '30d', l: '30 días' }, { v: '7d', l: '7 días' },
];
const BANDS: { v: GetKalshiLeaderboardBand; l: string }[] = [
  { v: 'all', l: 'Todas · desde $1k' }, { v: 'large', l: 'Grandes · umbral principal ≥ $10k' },
  { v: 'medium', l: 'Más de $5k y menos de $10k' }, { v: 'small', l: '$1k–$5k inclusive' },
];
const TYPE_NAMES = ROI_MARKET_NAMES;
const DIRS: { v: GetKalshiLeaderboardDirection; l: string }[] = [
  { v: 'all', l: 'YES y NO' }, { v: 'yes', l: 'Solo YES' }, { v: 'no', l: 'Solo NO' },
];
const MIN_OPTS = [1, 5, 10, 20, 50];
const COVERAGE: { v: GetKalshiLeaderboardCoverage; l: string }[] = [
  { v: 'verified', l: 'Solo historial final verificado' },
  { v: 'all', l: 'Incluir historiales parciales' },
];

function pick<T extends string>(v: string | null, opts: { v: T }[], d: T): T {
  return (opts.find((o) => o.v === v)?.v ?? d);
}
function when(v: string | null | undefined) {
  if (!v) return 'sin dato';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('es-US', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' ET';
}
function pct(v: number | null | undefined, sign = true) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  const s = v.toLocaleString('es-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return sign && v > 0 ? `+${s}%` : `${s}%`;
}
function usd(v: number) {
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(v));
  return v < 0 ? `-${s}` : v > 0 ? `+${s}` : s;
}
function tone(v: number | null | undefined) {
  if (v == null) return '';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}
function oddsText(r: RoiRankingRow) {
  if (r.oddsMin == null && r.oddsMax == null) return null;
  const lo = r.oddsMin ?? 0, hi = r.oddsMax ?? 1;
  const last = hi >= 1;
  const range = `${Math.round(lo * 100)}–${Math.round(hi * 100)}¢ ${last ? '(incl.)' : '(sin incluir el límite)'}`;
  return `${americanOddsRange(lo, hi)} · ${range}`;
}

function readInitial() {
  const p = new URLSearchParams(window.location.search);
  const groupBy = pick(p.get('lbGroup'), GROUPS, 'segment');
  const mg = Number(p.get('lbMin'));
  return {
    groupBy,
    sortBy: pick(p.get('lbSort'), SORTS, 'roi'),
    window: pick(p.get('lbWin'), WINDOWS, 'all'),
    band: pick(p.get('lbBand'), BANDS, 'all'),
    direction: pick(p.get('lbDir'), DIRS, 'all'),
    coverage: pick(p.get('lbCoverage'), COVERAGE, 'verified'),
    minGames: Number.isInteger(mg) && mg >= 1 && mg <= 1000 ? mg : groupBy === 'market' ? 1 : 10,
  };
}

function writeUrl(f: ReturnType<typeof readInitial>) {
  const p = new URLSearchParams(window.location.search);
  p.set('lbGroup', f.groupBy); p.set('lbWin', f.window); p.set('lbBand', f.band); p.set('lbDir', f.direction); p.set('lbMin', String(f.minGames));
  p.set('lbCoverage', f.coverage); p.set('lbSort', f.sortBy);
  window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
}

export function RoiLeaderboard() {
  const [f, setF] = useState(readInitial);
  const [page, setPage] = useState(1);

  function update(patch: Partial<typeof f>) {
    setF((old) => {
      const next = { ...old, ...patch };
      if (patch.groupBy && patch.groupBy !== old.groupBy && patch.minGames === undefined) {
        next.minGames = patch.groupBy === 'market' ? 1 : 10;
      }
      writeUrl(next);
      return next;
    });
    setPage(1);
  }

  const params: GetKalshiLeaderboardParams = { ...f, page };
  const q = useGetKalshiLeaderboard(params, {
    query: {
      queryKey: getGetKalshiLeaderboardQueryKey(params),
      refetchInterval: 60_000,
      retry: 1,
    },
  });
  const data = q.data;
  const stale = q.isPlaceholderData;

  return (
    <div className="lb" data-testid="roi-leaderboard">
      <section className="lb-head">
        <div>
          <div className="eyebrow">Ranking ROI · evidencia histórica</div>
          <h2><Trophy size={20} /> Ranking de ROI</h2>
          <p>Compara deporte, mercado, lado y odds con $100 hipotéticos por operación y liquidaciones oficiales. De mayor a menor ROI.</p>
        </div>
        <div className="lb-snap" data-testid="text-leaderboard-snapshot">
          {q.isFetching ? <><RefreshCw className="spin" size={12} /> Actualizando…</> : data ? <>Instantánea {when(data.generatedAt)}</> : 'Sin instantánea'}
          <small>Se actualiza cada 60 s</small>
        </div>
      </section>

      <div className="lb-caution" role="note" data-testid="text-leaderboard-caution">
        <AlertTriangle size={16} />
        <div>
          <strong>Histórico, no predicción.</strong> ROI hipotético sin comisiones ni deslizamiento. Las operaciones del mismo partido están correlacionadas; no garantiza rentabilidad futura.
        </div>
      </div>

      <div className="lb-filters" role="group" aria-label="Filtros del ranking">
        <div className="lb-filter wide">
          <span id="lb-view">Vista</span>
          <div className="ws-seg lb-seg" role="radiogroup" aria-labelledby="lb-view">
            {GROUPS.map((g) => (
              <button key={g.v} role="radio" aria-checked={f.groupBy === g.v} className={f.groupBy === g.v ? 'on' : ''} onClick={() => update({ groupBy: g.v })} data-testid={`button-group-${g.v}`}>{g.l}</button>
            ))}
          </div>
        </div>
        <div className="lb-filter">
          <span id="lb-sort">Ordenar por</span>
          <div className="ws-seg lb-seg" role="radiogroup" aria-labelledby="lb-sort">
            {SORTS.map((o) => (
              <button key={o.v} role="radio" aria-checked={f.sortBy === o.v} className={f.sortBy === o.v ? 'on' : ''} onClick={() => update({ sortBy: o.v })} data-testid={`button-sort-${o.v}`}>{o.l}</button>
            ))}
          </div>
        </div>
        <Sel id="lb-window" label="Periodo (fecha de ejecución)" value={f.window} opts={WINDOWS} onChange={(v) => update({ window: v })} />
        <Sel id="lb-band" label="Banda de tamaño" value={f.band} opts={BANDS} onChange={(v) => update({ band: v })} />
        <Sel id="lb-dir" label="Dirección" value={f.direction} opts={DIRS} onChange={(v) => update({ direction: v })} />
        <Sel id="lb-coverage" label="Calidad del histórico" value={f.coverage} opts={COVERAGE} onChange={(v) => update({ coverage: v })} />
        <div className="lb-filter">
          <span id="lb-min">Mínimo de partidos</span>
          <div className="ws-seg lb-seg" role="radiogroup" aria-labelledby="lb-min">
            {MIN_OPTS.map((n) => (
              <button key={n} role="radio" aria-checked={f.minGames === n} className={f.minGames === n ? 'on' : ''} onClick={() => update({ minGames: n })} data-testid={`button-min-games-${n}`}>{n}</button>
            ))}
          </div>
        </div>
      </div>

      {f.coverage === 'all' && <div className="lb-caution" role="note" data-testid="warning-partial-history">
        <AlertTriangle size={16} /><div><strong>Incluye historiales sin verificar.</strong> Pueden faltar operaciones y el ranking puede estar sesgado. Usa el historial final verificado para la comparación principal.</div>
      </div>}

      {f.groupBy === 'market' && (
        <div className="ws-notice warn" role="note" data-testid="text-market-view-note">
          <div><strong>Vista por mercado: solo retrospectiva</strong><p>Un mercado individual corresponde a un único partido, por eso el mínimo por defecto es 1. Su resultado ya ocurrió y no se repite: no es una estrategia replicable.</p></div>
        </div>
      )}

      {f.groupBy === 'amount' && (
        <div className="ws-notice" role="note" data-testid="text-amount-view-note">
          <div><strong>Vista por rango de importe observado</strong><p>Compara $1k–$5k (inclusive), más de $5k y menos de $10k, y $10k o más. Son importes de operaciones vistas, no tamaños de apuesta sugeridos. Aplica los mismos filtros de periodo, dirección, calidad, mínimo de partidos y banda: {f.band === 'all' ? 'con "Todas" se comparan los tres rangos.' : 'selecciona "Todas" en Banda de tamaño para comparar los tres rangos.'}</p></div>
          {f.band !== 'all' && <button className="button secondary" onClick={() => update({ band: 'all' })} data-testid="button-amount-all-bands">Comparar todos</button>}
        </div>
      )}

      {q.isError && (
        <div className="ws-notice error" role="alert" data-testid="status-leaderboard-error">
          <div><strong>{data ? 'No se pudo actualizar; se muestra la última instantánea' : 'No se pudo cargar el ranking'}</strong><p>{errorText(q.error, 'Error desconocido.')}</p></div>
          <button className="button secondary" onClick={() => void q.refetch()} data-testid="button-retry-leaderboard"><RefreshCw /> Reintentar</button>
        </div>
      )}

      {q.isLoading && <LoadingBlock />}

      {data && (
        <>
          <section className={`ws-card lb-card ${data.groupBy === 'segment' ? 'lb-combined-card' : ''} ${stale ? 'stale' : ''}`} aria-busy={stale} aria-labelledby="lb-table-title">
            <header className="row">
              <div>
                <h3 id="lb-table-title">{GROUPS.find((g) => g.v === data.groupBy)?.l ?? 'Ranking'} · ordenado por {data.sortBy === 'winRate' ? '% aciertos' : 'ROI'}</h3>
                <p>{data.totalRows.toLocaleString('es-US')} combinaciones con al menos {data.minGames} {data.minGames === 1 ? 'partido' : 'partidos'} · ${data.stakePerTrade} por operación{data.groupBy === 'segment' ? ' · YES y NO separados' : ' · reciente = últimos 7 días'}{data.band === 'large' ? ` · banda grande desde $${data.largeTradeThreshold.toLocaleString('en-US')}` : ''}</p>
              </div>
              {stale && <span className="lb-tag" data-testid="status-leaderboard-stale">Cargando filtros nuevos…</span>}
            </header>
            {data.rows.length === 0 ? (
              <EmptyRows s={data.summary} minGames={data.minGames} onLower={data.minGames > 1 ? () => update({ minGames: 1 }) : undefined} />
            ) : (
              <>
                {data.groupBy === 'amount' && <RoiAmountCompare data={data} />}
                {data.groupBy === 'segment' ? <RoiCombinedTable rows={data.rows} sortBy={data.sortBy} minGames={data.minGames} /> : <div className="lb-table-wrap">
                  <table className="ws-table lb-table" data-testid="table-leaderboard">
                    <caption className="sr-only">Ranking de ROI hipotético</caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Grupo</th>
                        <th scope="col" className="r" aria-sort={data.sortBy === 'roi' ? 'descending' : undefined}>ROI periodo</th>
                        <th scope="col" className="r">ROI reciente 7d</th>
                        <th scope="col" className="r">Resultado</th>
                        <th scope="col" className="r">Operaciones</th>
                        <th scope="col" className="r">Partidos · mercados</th>
                        <th scope="col" className="r" aria-sort={data.sortBy === 'winRate' ? 'descending' : undefined}>% aciertos · G / P</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => <Row key={r.id} r={r} data={data} />)}
                    </tbody>
                  </table>
                </div>}
                <nav className="lb-pager" aria-label="Paginación del ranking">
                  <button className="button secondary" disabled={data.page <= 1 || stale} onClick={() => setPage(Math.max(1, data.page - 1))} data-testid="button-page-prev"><ChevronLeft /> Anterior</button>
                  <span data-testid="text-page">Página {data.page} de {Math.max(1, data.totalPages)}</span>
                  <button className="button secondary" disabled={data.page >= data.totalPages || stale} onClick={() => setPage(data.page + 1)} data-testid="button-page-next">Siguiente <ChevronRight /></button>
                </nav>
              </>
            )}
          </section>
          <details className="lb-methodology" data-testid="details-roi-methodology">
            <summary>Cobertura y metodología <span>{data.summary.settledTrades.toLocaleString('es-US')} operaciones liquidadas · {data.summary.verifiedHistoryMarkets.toLocaleString('es-US')} mercados con historial verificado</span></summary>
            <div className="lb-methodology-body">
              <Coverage s={data.summary} />
              <p className="lb-foot">Cada ejecución recibe $100 hipotéticos al precio de entrada de su lado (YES o NO), mantenidos hasta la liquidación binaria oficial. ROI = resultado hipotético total / invertido × 100. No son ganancias reales. Un ranking ordenado por resultado ya conocido elige ganadores a posteriori y no demuestra que se pudiera ejecutar al mismo precio.</p>
              <p className="lb-foot">Operaciones pendientes, con liquidación no soportada o registros inválidos se excluyen; nunca cuentan como pérdidas. Por defecto también se excluyen los mercados cuyo historial final no está verificado. "Muestra pequeña" = menos de 10 partidos o menos de 30 operaciones; superar ese umbral no implica significancia estadística. Los partidos son estimados, no participantes únicos.</p>
            </div>
          </details>
          <p className="lb-foot">Odds americanas aproximadas, convertidas del precio del lado operado (NO usa su precio NO real). Tramos de 10¢: límite inferior incluido salvo 0¢ y superior excluido salvo 100¢. +100 equivale a 50¢; los extremos 0¢ y 100¢ se expresan como límites infinitos, no como cuotas disponibles.</p>
        </>
      )}
    </div>
  );
}

function Sel<T extends string>({ id, label, value, opts, onChange }: { id: string; label: string; value: T; opts: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="lb-filter ws-type-filter" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={`select-${id}`}>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

function Row({ r, data }: { r: RoiRankingRow; data: RoiLeaderboardData }) {
  const [open, setOpen] = useState(false);
  const odds = oddsText(r);
  const meta = [r.sport, r.marketType ? TYPE_NAMES[r.marketType] ?? r.marketType : null, r.side?.toUpperCase() ?? 'YES + NO', r.moneyBand ? `importe ${bandLabel(r.moneyBand)}` : null].filter(Boolean).join(' · ');
  const delta = r.recentRoiPct != null ? r.recentRoiPct - r.roiPct : null;
  return (
    <Fragment>
    <tr data-testid={`row-leaderboard-${r.id}`} className={open ? 'lb-open' : ''}>
      <td className="lb-rank">{r.rank}</td>
      <td className="lb-label">
        <div className="lb-name">
          <span data-testid={`text-label-${r.id}`}>{r.label}</span>
          {r.marketUrl && <a className="trade-link" href={r.marketUrl} target="_blank" rel="noreferrer" aria-label={`Abrir mercado ${r.label} en Kalshi`} data-testid={`link-market-${r.id}`}>Kalshi <ExternalLink /></a>}
        </div>
        {(meta || odds) && <small>{[meta, odds].filter(Boolean).join(' · ')}</small>}
        {r.sampleWarning && <span className="lb-tag warn" data-testid={`status-sample-${r.id}`}>Muestra pequeña</span>}
        <button type="button" className="lb-expand light" aria-expanded={open} aria-controls={domId('lb-detail', r.id)} onClick={() => setOpen(!open)} data-testid={`button-breakdown-${r.id}`}>
          <ChevronRight size={13} aria-hidden="true" className={open ? 'open' : ''} /> {open ? 'Ocultar' : 'Ver'} semanas y rangos de importe
        </button>
      </td>
      <td className={`r lb-roi ${tone(r.roiPct)}`} data-testid={`text-roi-${r.id}`}>{pct(r.roiPct)}</td>
      <td className="r">
        <span className={tone(r.recentRoiPct)} data-testid={`text-recent-roi-${r.id}`}>{pct(r.recentRoiPct)}</span>
        <small className="lb-sub">{r.recentTrades} op.{delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts` : ''}</small>
      </td>
      <td className={`r ${tone(r.profit)}`}>{usd(r.profit)}<small className="lb-sub">de ${r.invested.toLocaleString('en-US')}</small></td>
      <td className="r">{r.trades.toLocaleString('es-US')}</td>
      <td className="r">{r.games} · {r.markets}</td>
      <td className="r"><span className="lb-pct" data-testid={`text-winrate-${r.id}`}>{pct(r.winRatePct, false)}</span><small className="lb-sub">{r.wins} / {r.losses} ganadas / perdidas</small></td>
    </tr>
    {open && <tr className="lb-detail-row" id={domId('lb-detail', r.id)}><td colSpan={8}><RoiRowBreakdown row={r} minGames={data.minGames} /></td></tr>}
    </Fragment>
  );
}

function Coverage({ s }: { s: RoiCoverage }) {
  const pend = s.pendingTrades > 0 && s.settledTrades === 0;
  return (
    <>
      <section className="lb-kpis" aria-label="Cobertura de liquidaciones">
        <div className="hero-kpi">
          <span>ROI del periodo</span>
          <b className={tone(s.roiPct)} data-testid="text-summary-roi">{pct(s.roiPct)}</b>
          <small>{usd(s.profit)} hipotéticos · {s.settledTrades.toLocaleString('es-US')} liquidadas</small>
        </div>
        <div>
          <span>ROI reciente · 7 días</span>
          <b className={tone(s.recentRoiPct)} data-testid="text-summary-recent-roi">{pct(s.recentRoiPct)}</b>
          <small>{s.recentTrades.toLocaleString('es-US')} operaciones recientes{s.recentTrades < 30 ? ' · muestra pequeña' : ''}</small>
        </div>
        <div>
          <span>Cobertura</span>
          <b data-testid="text-summary-coverage">{s.settledTrades.toLocaleString('es-US')} / {s.savedTrades.toLocaleString('es-US')}</b>
          <small>{s.pendingTrades.toLocaleString('es-US')} pendientes · {s.excludedTrades.toLocaleString('es-US')} excluidas</small>
          <small>{s.historyExcludedTrades.toLocaleString('es-US')} excluidas por historial sin verificar</small>
        </div>
        <div>
          <span>Mercados · partidos</span>
          <b data-testid="text-summary-markets">{s.settledMarkets} · {s.games}</b>
          <small>{s.pendingMarkets} mercados por liquidar · partidos estimados</small>
        </div>
      </section>
      <div className={`ws-notice ${s.settlementErrors > 0 || pend || s.incompleteHistoryMarkets > 0 ? 'warn' : ''}`} role="status" data-testid="text-settlement-coverage">
        <div>
          <strong><Scale size={13} /> Liquidaciones oficiales</strong>
          <p>
            Ejecuciones del {when(s.firstTradeAt)} al {when(s.lastTradeAt)}. Última revisión de liquidaciones: {when(s.lastSettlementCheckAt)}.
            {' '}Las resoluciones se incorporan automáticamente por lotes. La primera carga puede tardar; mientras tanto, las operaciones pendientes no participan en el ROI. La cobertura corresponde solo al histórico guardado por este monitor, no a todas las operaciones de Kalshi.
            {s.settlementErrors > 0 ? ` ${s.settlementErrors} consultas de liquidación fallaron y se reintentarán.` : ''}
            {' '}Historial final: {s.verifiedHistoryMarkets} mercados verificados y {s.incompleteHistoryMarkets} sin verificar.
            {' '}Se verifica recorriendo ambas fuentes de operaciones disponibles, sin saltar páginas y después de la resolución oficial. No garantiza que Kalshi publique todas las operaciones ni que este monitor haya descubierto todos los mercados.
            {s.historyErrorMarkets > 0 ? ` ${s.historyErrorMarkets} históricos tienen errores y se reintentarán; no se certifican como completos.` : ''}
          </p>
        </div>
      </div>
    </>
  );
}

function EmptyRows({ s, minGames, onLower }: { s: RoiCoverage; minGames: number; onLower?: () => void }) {
  const none = s.settledTrades === 0;
  return (
    <div className="ws-empty small lb-empty" data-testid={none ? 'empty-leaderboard' : 'empty-qualified-groups'}>
      <h3>{none ? s.historyExcludedTrades > 0 ? 'Historial final en verificación' : 'Aún no hay operaciones liquidadas' : 'Ningún grupo alcanza el mínimo'}</h3>
      <p>{none && s.historyExcludedTrades > 0
        ? `${s.historyExcludedTrades.toLocaleString('es-US')} operaciones resueltas esperan la revisión completa del historial de su mercado. Todavía no participan en el ROI. Puedes incluir datos parciales con el filtro de calidad, con las limitaciones indicadas.`
        : none
        ? `Hay ${s.pendingTrades.toLocaleString('es-US')} operaciones esperando liquidación oficial. El ranking aparece cuando lleguen resultados; no se muestran filas inventadas.`
        : `Con estos filtros ningún grupo tiene al menos ${minGames} partidos liquidados.`}</p>
      {!none && onLower && <button className="button secondary" onClick={onLower} data-testid="button-lower-min-games">Bajar el mínimo a 1</button>}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div aria-label="Cargando ranking" data-testid="loading-leaderboard">
      <div className="lb-kpis">{[0, 1, 2, 3].map((i) => <div key={i}><div className="skeleton skeleton-line" style={{ width: '50%' }} /><div className="skeleton skeleton-line" style={{ width: '70%', height: 24 }} /></div>)}</div>
      <div className="ws-card" style={{ padding: 20 }}>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton skeleton-line" style={{ height: 30 }} />)}</div>
    </div>
  );
}
