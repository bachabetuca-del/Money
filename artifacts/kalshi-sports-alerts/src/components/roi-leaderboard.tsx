import { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Scale, Trophy } from 'lucide-react';
import {
  getGetKalshiLeaderboardQueryKey,
  useGetKalshiLeaderboard,
  type GetKalshiLeaderboardBand,
  type GetKalshiLeaderboardCoverage,
  type GetKalshiLeaderboardDirection,
  type GetKalshiLeaderboardGroupBy,
  type GetKalshiLeaderboardParams,
  type GetKalshiLeaderboardWindow,
  type RoiCoverage,
  type RoiRankingRow,
} from '@workspace/api-client-react';
import { errorText } from '@/components/history-export';
import './roi-leaderboard.css';

const TZ = 'America/New_York';
const GROUPS: { v: GetKalshiLeaderboardGroupBy; l: string }[] = [
  { v: 'sport', l: 'Deportes' },
  { v: 'marketType', l: 'Tipos de mercado' },
  { v: 'odds', l: 'Rangos de cuota' },
  { v: 'segment', l: 'Segmentos' },
  { v: 'market', l: 'Mercados individuales' },
];
const WINDOWS: { v: GetKalshiLeaderboardWindow; l: string }[] = [
  { v: 'all', l: 'Todo' }, { v: '30d', l: '30 días' }, { v: '7d', l: '7 días' },
];
const BANDS: { v: GetKalshiLeaderboardBand; l: string }[] = [
  { v: 'all', l: 'Todas · desde $1k' }, { v: 'large', l: 'Grandes · umbral principal ≥ $10k' },
  { v: 'medium', l: 'Más de $5k y menos de $10k' }, { v: 'small', l: '$1k–$5k inclusive' },
];
const TYPE_NAMES: Record<string, string> = {
  winner: 'Ganador', spread: 'Hándicap', total: 'Totales', props: 'Estadísticas de jugadores',
  futures: 'Campeonatos / Futuros', other: 'Otros / Sin clasificar',
};
const DIRS: { v: GetKalshiLeaderboardDirection; l: string }[] = [
  { v: 'all', l: 'SÍ y NO' }, { v: 'yes', l: 'Solo SÍ' }, { v: 'no', l: 'Solo NO' },
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
  const dHi = lo > 0 ? (1 / lo).toFixed(2) : '∞';
  const dLo = (1 / hi).toFixed(2);
  return `${range} · cuota decimal ${dLo}–${dHi}`;
}

function readInitial() {
  const p = new URLSearchParams(window.location.search);
  const groupBy = pick(p.get('lbGroup'), GROUPS, 'sport');
  const mg = Number(p.get('lbMin'));
  return {
    groupBy,
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
  p.set('lbCoverage', f.coverage);
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
          <h2><Trophy size={20} /> Qué habría pasado con $100 por operación</h2>
          <p>Cada ejecución guardada recibe una inversión hipotética igual de $100, en su dirección observada (SÍ o NO) y a su propio precio de entrada, mantenida hasta la liquidación binaria oficial. Es un ejercicio retrospectivo, no ganancias reales ni una predicción.</p>
        </div>
        <div className="lb-snap" data-testid="text-leaderboard-snapshot">
          {q.isFetching ? <><RefreshCw className="spin" size={12} /> Actualizando…</> : data ? <>Instantánea {when(data.generatedAt)}</> : 'Sin instantánea'}
          <small>Se actualiza cada 60 s</small>
        </div>
      </section>

      <div className="lb-caution" role="note" data-testid="text-leaderboard-caution">
        <AlertTriangle size={16} />
        <div>
          <strong>Sin rentabilidad garantizada.</strong> Un ranking ordenado por resultado ya conocido elige ganadores a posteriori. Las operaciones de un mismo partido están correlacionadas, el recuento de partidos es una estimación, y no se incluyen comisiones, deslizamiento ni la posibilidad real de ejecutar al mismo precio.
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

      {q.isError && (
        <div className="ws-notice error" role="alert" data-testid="status-leaderboard-error">
          <div><strong>{data ? 'No se pudo actualizar; se muestra la última instantánea' : 'No se pudo cargar el ranking'}</strong><p>{errorText(q.error, 'Error desconocido.')}</p></div>
          <button className="button secondary" onClick={() => void q.refetch()} data-testid="button-retry-leaderboard"><RefreshCw /> Reintentar</button>
        </div>
      )}

      {q.isLoading && <LoadingBlock />}

      {data && (
        <>
          <Coverage s={data.summary} />
          <section className={`ws-card lb-card ${stale ? 'stale' : ''}`} aria-busy={stale} aria-labelledby="lb-table-title">
            <header className="row">
              <div>
                <h3 id="lb-table-title">{GROUPS.find((g) => g.v === data.groupBy)?.l ?? 'Ranking'} · ordenado por ROI</h3>
                <p>{data.totalRows.toLocaleString('es-US')} grupos con al menos {data.minGames} {data.minGames === 1 ? 'partido' : 'partidos'} · ${data.stakePerTrade} por operación · reciente = ejecuciones de los últimos 7 días dentro del periodo.</p>
              </div>
              {stale && <span className="lb-tag" data-testid="status-leaderboard-stale">Cargando filtros nuevos…</span>}
            </header>
            {data.rows.length === 0 ? (
              <EmptyRows s={data.summary} minGames={data.minGames} onLower={data.minGames > 1 ? () => update({ minGames: 1 }) : undefined} />
            ) : (
              <>
                <div className="lb-table-wrap">
                  <table className="ws-table lb-table" data-testid="table-leaderboard">
                    <caption className="sr-only">Ranking de ROI hipotético</caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Grupo</th>
                        <th scope="col" className="r">ROI periodo</th>
                        <th scope="col" className="r">ROI reciente 7d</th>
                        <th scope="col" className="r">Resultado</th>
                        <th scope="col" className="r">Operaciones</th>
                        <th scope="col" className="r">Partidos · mercados</th>
                        <th scope="col" className="r">Ganadas / perdidas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => <Row key={r.id} r={r} />)}
                    </tbody>
                  </table>
                </div>
                <nav className="lb-pager" aria-label="Paginación del ranking">
                  <button className="button secondary" disabled={data.page <= 1 || stale} onClick={() => setPage(Math.max(1, data.page - 1))} data-testid="button-page-prev"><ChevronLeft /> Anterior</button>
                  <span data-testid="text-page">Página {data.page} de {Math.max(1, data.totalPages)}</span>
                  <button className="button secondary" disabled={data.page >= data.totalPages || stale} onClick={() => setPage(data.page + 1)} data-testid="button-page-next">Siguiente <ChevronRight /></button>
                </nav>
              </>
            )}
          </section>
          <p className="lb-foot">ROI = resultado hipotético total / invertido × 100. Operaciones pendientes, con liquidación no soportada o registros inválidos se excluyen; nunca cuentan como pérdidas. Por defecto también se excluyen los mercados cuyo historial final no está verificado. "Muestra pequeña" = menos de 10 partidos o menos de 30 operaciones; superar ese umbral no implica significancia estadística. Cuotas por precio del lado operado (NO usa su precio NO real), en tramos de 10¢.</p>
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

function Row({ r }: { r: RoiRankingRow }) {
  const odds = oddsText(r);
  const meta = [r.sport, r.marketType ? TYPE_NAMES[r.marketType] ?? r.marketType : null].filter(Boolean).join(' · ');
  const delta = r.recentRoiPct != null ? r.recentRoiPct - r.roiPct : null;
  return (
    <tr data-testid={`row-leaderboard-${r.id}`}>
      <td className="lb-rank">{r.rank}</td>
      <td className="lb-label">
        <div className="lb-name">
          <span data-testid={`text-label-${r.id}`}>{r.label}</span>
          {r.marketUrl && <a className="trade-link" href={r.marketUrl} target="_blank" rel="noreferrer" aria-label={`Abrir mercado ${r.label} en Kalshi`} data-testid={`link-market-${r.id}`}>Kalshi <ExternalLink /></a>}
        </div>
        {(meta || odds) && <small>{[meta, odds].filter(Boolean).join(' · ')}</small>}
        {r.sampleWarning && <span className="lb-tag warn" data-testid={`status-sample-${r.id}`}>Muestra pequeña</span>}
      </td>
      <td className={`r lb-roi ${tone(r.roiPct)}`} data-testid={`text-roi-${r.id}`}>{pct(r.roiPct)}</td>
      <td className="r">
        <span className={tone(r.recentRoiPct)} data-testid={`text-recent-roi-${r.id}`}>{pct(r.recentRoiPct)}</span>
        <small className="lb-sub">{r.recentTrades} op.{delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts` : ''}</small>
      </td>
      <td className={`r ${tone(r.profit)}`}>{usd(r.profit)}<small className="lb-sub">de ${r.invested.toLocaleString('en-US')}</small></td>
      <td className="r">{r.trades.toLocaleString('es-US')}</td>
      <td className="r">{r.games} · {r.markets}</td>
      <td className="r">{r.wins} / {r.losses}<small className="lb-sub">{pct(r.winRatePct, false)} aciertos</small></td>
    </tr>
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
