import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronRight, Download, ExternalLink, Pause, Play, RefreshCw, Search } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { getGetKalshiExplorerQueryKey, useGetKalshiExplorer } from '@workspace/api-client-react';
import { useLiveExplorer } from '@/hooks/use-live-explorer';
import { MarketFlow } from '@/components/market-flow';
import { HistoryExport } from '@/components/history-export';
import { GameAnalysisPanel } from '@/components/game-analysis-panel';
import { diffFresh, FALLBACK_MS, FRESH_MS, lastExecution, viewSnapshot, type SeenState } from '@/lib/live-model';
import { MINUTE, RECENT_MS, yesQuote, bubbleRadius, buildBuckets, groupMarkets, type Bucket, type Dir } from '@/lib/explorer-model';
import type {
  KalshiExplorer,
  ExplorerTrade,
  GetKalshiExplorerBand,
  GetKalshiExplorerScope,
  GetKalshiExplorerWindow,
} from '@workspace/api-client-react';

const TZ = 'America/New_York';
const COLORS = { yes: '#1f7a8c', no: '#c9822b', unknown: '#8a948f' } as const;
const DIR_LABEL: Record<Dir, string> = {
  yes: 'A favor (SÍ)',
  no: 'En contra (NO)',
  unknown: 'Dirección sin dato',
};
const DIR_MEANING: Record<Dir, string> = {
  yes: 'Compra SÍ o venta NO',
  no: 'Compra NO o venta SÍ',
  unknown: 'La fuente no informó la dirección',
};
const STATE_LABEL: Record<string, string> = {
  live: 'En vivo',
  upcoming: 'Próximo',
  finished: 'Finalizado',
  unknown: 'Sin estado',
};

export function usd(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
function usdShort(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return `$${Math.round(value)}`;
}
function fmtTime(ms: number | string, seconds = true) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return new Intl.DateTimeFormat('es-US', {
    timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: false,
  }).format(d) + ' ET';
}
function axisTime(ms: number, span: number) {
  const d = new Date(ms);
  if (span >= 2 * 1440 * MINUTE) return new Intl.DateTimeFormat('es-US', { timeZone: TZ, day: '2-digit', month: 'short' }).format(d);
  return new Intl.DateTimeFormat('es-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

type Params = {
  band: GetKalshiExplorerBand;
  scope: GetKalshiExplorerScope;
  win: GetKalshiExplorerWindow;
  ticker: string;
  q: string;
  direction: 'all' | 'yes' | 'no';
};

function readParams(): Params {
  const p = new URLSearchParams(window.location.search);
  const band = p.get('band') === 'small' ? 'small' : p.get('band') === 'medium' ? 'medium' : 'large';
  const scope = p.get('scope') === 'history' ? 'history' : 'active';
  const w = p.get('window');
  const win = w === '1h' || w === '24h' ? w : 'all';
  const direction = p.get('direction') === 'yes' ? 'yes' : p.get('direction') === 'no' ? 'no' : 'all';
  return { band, scope, win, direction, ticker: (p.get('ticker') ?? '').slice(0, 200), q: '' };
}

export function setUrlParams(values: Record<string, string | null>) {
  const p = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(values)) {
    if (value) p.set(key, value); else p.delete(key);
  }
  const qs = p.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ws-seg" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} className={value === key ? 'on' : ''} onClick={() => onChange(key)} data-testid={`filter-${label}-${key}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'error'; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`ws-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

type Point = { t: number; quote: number; usd: number; count: number; dir: Dir; id: string; price: number; recent: boolean };

function widthLabel(width: number) {
  if (width < 60 * MINUTE) return `${Math.round(width / MINUTE)} min`;
  if (width < 1440 * MINUTE) return `${Math.round(width / (60 * MINUTE))} h`;
  return `${Math.round(width / (1440 * MINUTE))} d`;
}

type TipProps = { active?: boolean; payload?: { payload: Point | (Bucket & { label: string }) }[] };

function ScatterTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as Point;
  if (p.dir === undefined) return null;
  return (
    <div className="ws-tip">
      <b>{usd(p.usd)}</b>
      <span>{p.count.toLocaleString('en-US')} contratos a {(p.price * 100).toFixed(2)}¢ ({p.dir === 'yes' ? 'precio SÍ' : 'precio NO'})</span>
      <span>Cotización SÍ equivalente: {p.quote.toFixed(2)}¢</span>
      <span>{DIR_LABEL[p.dir]} · {DIR_MEANING[p.dir]}</span>
      <span>{fmtTime(p.t)}{p.recent ? ' · últimos 15 min' : ''}</span>
      <span className="mono">{p.id}</span>
    </div>
  );
}

function BarTip({ active, payload }: TipProps) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload as Bucket;
  if (b.n === undefined) return null;
  return (
    <div className="ws-tip">
      <b>{usd(b.total)} · {b.n} {b.n === 1 ? 'operación' : 'operaciones'}</b>
      <span>{fmtTime(b.start, false)} a {fmtTime(b.end, false)}</span>
      {(['yes', 'no', 'unknown'] as Dir[]).map((d) => {
        const v = b[d] + b[`${d}R` as 'yesR'];
        return v > 0 ? <span key={d}><i style={{ background: COLORS[d] }} className="ws-dot" /> {DIR_LABEL[d]}: {usd(v)}</span> : null;
      })}
      {(b.yesR + b.noR + b.unknownR) > 0 && <span>Últimos 15 min: {usd(b.yesR + b.noR + b.unknownR)}</span>}
    </div>
  );
}

function Charts({ trades, scope, now, truncated, total, fresh }: { trades: ExplorerTrade[]; scope: string; now: number; truncated: boolean; total: number; fresh: Set<string> }) {
  const highlight = scope === 'active';
  const model = useMemo(() => {
    const b = buildBuckets(trades, now, highlight);
    const points: Point[] = [];
    let unknownCount = 0;
    for (const t of trades) {
      const quote = yesQuote(t);
      const ms = new Date(t.createdTime).getTime();
      if (quote === null) { unknownCount += 1; continue; }
      points.push({ t: ms, quote: quote * 100, usd: t.notional, count: t.count, dir: t.direction as Dir, id: t.tradeId, price: t.price, recent: highlight && ms >= now - RECENT_MS && ms <= now });
    }
    return { ...b, points, unknownCount };
  }, [trades, now, highlight]);
  const span = model.end - model.start;
  const bars = model.buckets.map((b) => ({ ...b, mid: b.start + (b.end - b.start) / 2 }));
  const yesPts = model.points.filter((p) => p.dir === 'yes');
  const noPts = model.points.filter((p) => p.dir === 'no');
  const dot = (color: string) => (props: { cx?: number; cy?: number; size?: number; payload?: Point }) => (
    <circle cx={props.cx} cy={props.cy} r={bubbleRadius(props.size)} fill={color} fillOpacity={0.8} stroke={props.payload && fresh.has(props.payload.id) ? '#d9a21b' : props.payload?.recent ? '#1c2b26' : '#fff'} strokeWidth={props.payload && fresh.has(props.payload.id) ? 4 : props.payload?.recent ? 2.5 : 1} />
  );
  return (
    <div className="ws-charts">
      {truncated && (
        <Notice tone="warn" title="Gráficos con las últimas 5,000 operaciones">
          Se cargaron {trades.length.toLocaleString('en-US')} de {total.toLocaleString('en-US')} operaciones guardadas en esta ventana. Los gráficos y la tabla no incluyen las más antiguas; el resumen de flujo sí cubre todas.
        </Notice>
      )}
      <section className="ws-card">
        <header>
          <h3>Dinero por intervalo de {widthLabel(model.width)}</h3>
          <p>Cada barra suma el importe de sus operaciones. Los intervalos vacíos se muestran vacíos. Hora de Nueva York.</p>
          {highlight && <p className="strong">{model.recentCount ? `Últimos 15 min: ${model.recentCount} op. · ${usd(model.recentSum)}` : 'Sin operaciones en los últimos 15 min (hora de ejecución).'}</p>}
        </header>
        <div className="ws-plot" data-testid="chart-money-buckets">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={bars} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="12%">
              <CartesianGrid stroke="#e3e0d4" strokeDasharray="3 6" vertical={false} />
              <XAxis dataKey="start" tickFormatter={(v: number) => axisTime(v, span)} tick={{ fontSize: 11, fill: '#667' }} minTickGap={36} />
              <YAxis tickFormatter={usdShort} tick={{ fontSize: 11, fill: '#667' }} width={54} />
              <ChartTooltip content={<BarTip />} cursor={{ fill: '#17493a14' }} />
              <Bar dataKey="yes" stackId="a" fill={COLORS.yes} fillOpacity={0.55} isAnimationActive={false} />
              <Bar dataKey="yesR" stackId="a" fill={COLORS.yes} isAnimationActive={false} />
              <Bar dataKey="no" stackId="a" fill={COLORS.no} fillOpacity={0.55} isAnimationActive={false} />
              <Bar dataKey="noR" stackId="a" fill={COLORS.no} isAnimationActive={false} />
              <Bar dataKey="unknown" stackId="a" fill={COLORS.unknown} fillOpacity={0.55} isAnimationActive={false} />
              <Bar dataKey="unknownR" stackId="a" fill={COLORS.unknown} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="ws-legend">
          {(['yes', 'no', 'unknown'] as Dir[]).map((d) => <span key={d}><i className="ws-dot" style={{ background: COLORS[d] }} />{DIR_LABEL[d]}</span>)}
          {highlight && <span>Color pleno = últimos 15 min; tenue = anterior</span>}
        </div>
      </section>

      <section className="ws-card">
        <header>
          <h3>Cotización SÍ equivalente por operación</h3>
          <p>Precio SÍ = precio si la dirección es SÍ; 1 menos el precio si es NO. Las operaciones sin dirección no se infieren y no aparecen aquí. Tamaño del punto = dinero.</p>
        </header>
        {model.unknownCount > 0 && <p className="ws-sub warn">{model.unknownCount} operaciones sin dirección quedan fuera de este gráfico (siguen en las barras y la tabla).</p>}
        {model.points.length === 0 ? (
          <div className="ws-empty small">Ninguna operación tiene dirección conocida.</div>
        ) : (
          <div className="ws-plot" data-testid="chart-yes-quote">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="#e3e0d4" strokeDasharray="3 6" />
                <XAxis type="number" dataKey="t" domain={[model.start, model.end]} tickFormatter={(v: number) => axisTime(v, span)} tick={{ fontSize: 11, fill: '#667' }} scale="time" minTickGap={36} />
                <YAxis type="number" dataKey="quote" domain={[0, 100]} unit="¢" tick={{ fontSize: 11, fill: '#667' }} width={48} />
                <ZAxis type="number" dataKey="usd" range={[40, 360]} />
                <ChartTooltip content={<ScatterTip />} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter name="SÍ" data={yesPts} shape={dot(COLORS.yes)} isAnimationActive={false} />
                <Scatter name="NO" data={noPts} shape={dot(COLORS.no)} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="ws-legend">
          <span><i className="ws-dot" style={{ background: COLORS.yes }} />Dirección SÍ</span>
          <span><i className="ws-dot" style={{ background: COLORS.no }} />Dirección NO (convertida a cotización SÍ)</span>
          {highlight && <span>Borde oscuro = últimos 15 min · borde dorado = recién guardada</span>}
        </div>
      </section>
    </div>
  );
}

function TradeTable({ trades, now, highlight, report, fresh, direction }: {
  trades: ExplorerTrade[]; now: number; highlight: boolean; fresh: Set<string>;
  direction: Params['direction'];
  report: Omit<import('@/lib/trade-pdf').TradePdfInput, 'trades' | 'directionLabel' | 'search'>;
}) {
  const [dir, setDir] = useState<'all' | Dir>(direction);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return [...trades]
      .filter((t) => (dir === 'all' || t.direction === dir) && (!term || t.tradeId.toLowerCase().includes(term)))
      .sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
  }, [trades, dir, q]);
  async function downloadPdf() {
    setExporting(true);
    setExportError('');
    // Snapshot the displayed selection before loading the PDF library.
    const input = { ...report, trades: rows, directionLabel: dir === 'all' ? 'Todas' : DIR_LABEL[dir], search: q };
    try {
      const { buildTradePdf, tradePdfFilename } = await import('@/lib/trade-pdf');
      await buildTradePdf(input).save(tradePdfFilename(input.market.ticker, input.generatedAt), { returnPromise: true });
    } catch {
      setExportError('No se pudo generar el PDF. Inténtalo de nuevo.');
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="ws-card">
      <header className="row">
        <div>
          <h3>Operaciones detalladas</h3>
          <p>{rows.length.toLocaleString('en-US')} de {trades.length.toLocaleString('en-US')} cargadas · más recientes primero</p>
        </div>
        <div className="ws-tools">
          <button className="button secondary" onClick={() => void downloadPdf()} disabled={exporting || rows.length === 0} data-testid="button-download-trades-pdf">
            <Download size={15} /> {exporting ? 'Generando PDF…' : 'Descargar PDF'}
          </button>
          {direction === 'all' && <Seg label="dir" value={dir} onChange={(v) => { setDir(v); setLimit(100); }} options={[['all', 'Todas'], ['yes', 'SÍ'], ['no', 'NO'], ['unknown', 'Sin dato']]} />}
          <label className="ws-search small"><Search size={13} /><input value={q} onChange={(e) => { setQ(e.target.value); setLimit(100); }} placeholder="ID de operación" aria-label="Buscar operación" data-testid="input-search-trade" /></label>
        </div>
      </header>
      {exportError && <p role="alert">{exportError}</p>}
      {rows.length === 0 ? <div className="ws-empty small">Ninguna operación coincide con este filtro.</div> : (
        <div className="ws-table-wrap">
          <table className="ws-table">
            <thead><tr><th>Hora (ET)</th><th>Dirección</th><th className="r">Precio</th><th className="r">Cot. SÍ</th><th className="r">Contratos</th><th className="r">USD</th></tr></thead>
            <tbody>
              {rows.slice(0, limit).map((t) => {
                const ms = new Date(t.createdTime).getTime();
                const recent = highlight && ms >= now - RECENT_MS && ms <= now;
                const isFresh = fresh.has(t.tradeId);
                const quote = yesQuote(t);
                const d = t.direction as Dir;
                return (
                  <tr key={t.tradeId} data-testid={`row-explorer-trade-${t.tradeId}`} className={isFresh ? 'recent fresh' : recent ? 'recent' : ''}>
                    <td className="mono">{fmtTime(ms)}{isFresh ? <em className="new"> nueva</em> : recent && <em> reciente</em>}</td>
                    <td title={DIR_MEANING[d]}><i className="ws-dot" style={{ background: COLORS[d] }} /> {DIR_LABEL[d]}</td>
                    <td className="r mono">{(t.price * 100).toFixed(2)}¢</td>
                    <td className="r mono">{quote === null ? 'sin dato' : `${(quote * 100).toFixed(2)}¢`}</td>
                    <td className="r mono">{t.count.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                    <td className="r mono b">{usd(t.notional)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit && <button className="ws-more" onClick={() => setLimit(limit + 200)} data-testid="button-more-trades">Mostrar más ({rows.length - limit} restantes)</button>}
    </section>
  );
}

export function Explorer() {
  const [params, setParams] = useState<Params>(readParams);
  const [openSports, setOpenSports] = useState<Set<string>>(new Set());
  const [openGames, setOpenGames] = useState<Set<string>>(new Set());
  const { band, scope, win, ticker, q, direction } = params;

  useEffect(() => {
    setUrlParams({ band: band === 'large' ? null : band, scope: scope === 'active' ? null : scope, window: win === 'all' ? null : win, ticker: ticker || null, direction: direction === 'all' ? null : direction });
  }, [band, scope, win, ticker, direction]);

  const [paused, setPaused] = useState(false);
  const catalogParams = { band, scope, direction, window: 'all' as const };
  const catalog = useGetKalshiExplorer(catalogParams, { query: { refetchInterval: FALLBACK_MS, retry: false } });
  const detailParams = { band, scope, direction, window: win, ticker };
  const detailKey = ['/api/kalshi/explorer', detailParams] as const;
  const detail = useGetKalshiExplorer(detailParams, {
    query: { enabled: ticker.length > 0 && !paused, refetchInterval: FALLBACK_MS, retry: false, queryKey: detailKey },
  });

  // Live stream: refetch only the matching active detail (throttled) and the catalog.
  const qc = useQueryClient();
  const liveRef = useRef({ ticker, paused, detailKey, catalogKey: getGetKalshiExplorerQueryKey(catalogParams), scope });
  liveRef.current = { ticker, paused, detailKey, catalogKey: getGetKalshiExplorerQueryKey(catalogParams), scope };
  const liveEventPending = useRef(false);
  const liveFreshIds = useRef(new Set<string>());
  const timers = useRef<{ detail?: ReturnType<typeof setTimeout>; catalog?: ReturnType<typeof setTimeout> }>({});
  const schedule = useCallback((which: 'detail' | 'catalog', fromEvent: boolean) => {
    if (which === 'detail' && fromEvent) liveEventPending.current = true;
    if (timers.current[which]) return;
    timers.current[which] = setTimeout(() => {
      timers.current[which] = undefined;
      const cur = liveRef.current;
      if (which === 'catalog') void qc.invalidateQueries({ queryKey: cur.catalogKey, exact: true }, { cancelRefetch: false });
      else if (cur.ticker && !cur.paused) void qc.invalidateQueries({ queryKey: cur.detailKey, exact: true }, { cancelRefetch: false });
    }, which === 'detail' ? 400 : 5000);
  }, [qc]);
  useEffect(() => () => { clearTimeout(timers.current.detail); clearTimeout(timers.current.catalog); }, []);
  const liveStatus = useLiveExplorer(true, {
    onTrades: (tickers, freshIds) => {
      const cur = liveRef.current;
      schedule('catalog', true);
      if (cur.scope === 'active' && !cur.paused && tickers.includes(cur.ticker)) {
        for (const id of freshIds) liveFreshIds.current.add(id);
        schedule('detail', true);
      }
    },
    onReady: () => {
      liveEventPending.current = false;
      liveFreshIds.current.clear();
      schedule('catalog', false);
      schedule('detail', false);
    },
  });

  const markets = catalog.data?.markets;
  const selected = markets?.find((m) => m.ticker === ticker);
  const grouped = useMemo(() => groupMarkets(markets ?? [], q), [markets, q]);

  // Open a real chart immediately; never keep an incompatible band/scope selection.
  useEffect(() => {
    if (markets && (!ticker || !markets.some((m) => m.ticker === ticker))) {
      const next = markets[0]?.ticker ?? '';
      if (ticker !== next) setParams((p) => ({ ...p, ticker: next }));
    }
  }, [markets, ticker]);

  const change = (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch }));
  const liveData = detail.data;
  const liveNow = useMemo(() => Date.now(), [liveData]);
  const selKey = `${ticker}:${band}:${win}:${scope}:${direction}`;

  // Genuinely new IDs: only from refetches triggered by a live event for the same selection.
  const seen = useRef<SeenState>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!liveData || paused) return;
    const fromEvent = liveEventPending.current && scope === 'active';
    liveEventPending.current = false;
    const r = diffFresh(seen.current, selKey, liveData.trades.filter((t) => t.ticker === ticker).map((t) => t.tradeId), fromEvent);
    r.fresh = r.fresh.filter(id => liveFreshIds.current.has(id));
    liveFreshIds.current.clear();
    const switched = seen.current?.key !== selKey;
    seen.current = r.seen;
    if (switched) setFresh(new Map());
    if (r.fresh.length) {
      const until = Date.now() + FRESH_MS;
      setFresh((m) => { const n = new Map(m); for (const id of r.fresh) n.set(id, until); return n; });
    }
  }, [liveData]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fresh.size) return;
    const next = Math.min(...fresh.values()) - Date.now();
    const t = setTimeout(() => setFresh((m) => {
      const n = new Map<string, number>();
      for (const [id, until] of m) if (until > Date.now()) n.set(id, until);
      return n;
    }), Math.max(50, next));
    return () => clearTimeout(t);
  }, [fresh]);
  const freshIds = useMemo(() => new Set(fresh.keys()), [fresh]);

  // Pause: freeze the whole selected snapshot (data + clock); the catalog may keep updating.
  const [frozen, setFrozen] = useState<{ data: KalshiExplorer | undefined; now: number; key: string } | null>(null);
  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
      liveEventPending.current = false;
      liveFreshIds.current.clear();
      void qc.invalidateQueries({ queryKey: detailKey, exact: true });
    } else {
      setFrozen({ data: liveData, now: liveNow, key: selKey });
      setFresh(new Map());
      setPaused(true);
    }
  };
  useEffect(() => { if (paused && frozen && frozen.key !== selKey) { setPaused(false); setFrozen(null); } }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = viewSnapshot(paused, frozen, { data: liveData, now: liveNow, key: selKey });
  const dData = view.data;
  const now = view.now;
  const trades = useMemo(() => (dData && selected ? dData.trades.filter((t) => t.ticker === ticker) : []), [dData, selected, ticker]);
  const lastExec = useMemo(() => lastExecution(trades.map((t) => t.createdTime)), [trades]);
  const stale = (catalog.isError && !!catalog.data) || (detail.isError && !!dData);
  const totals = useMemo(() => {
    const s = { yes: 0, no: 0, unknown: 0 };
    for (const t of trades) s[t.direction as Dir] += t.notional;
    return s;
  }, [trades]);
  const grand = totals.yes + totals.no + totals.unknown;
  const bandText = band === 'small' ? 'Operaciones de $1,000 a $5,000, ambos incluidos' :
    band === 'medium' ? 'Operaciones mayores a $5,000 y menores a $10,000' : 'Operaciones grandes: umbral configurado, mínimo $10,000';
  const scopeText = scope === 'active' ? 'Vigentes: en juego y próximas 48 h' : 'Historial: partidos antiguos o finalizados';

  return (
    <div className="ws" data-testid="explorer">
      {catalog.data?.workersPaused && (
        <Notice tone="info" title="Bot de desarrollo en pausa">
          Esta es la versión de desarrollo: el bot no está conectado ni ingiriendo datos en vivo. Se muestran únicamente los datos ya guardados.
        </Notice>
      )}
      {stale && <Notice tone="warn" title="Datos desactualizados">No se pudo actualizar; se muestra la última carga correcta. Se reintenta automáticamente.</Notice>}

      <div className="ws-filters">
        <Seg label="scope" value={scope} onChange={(v) => change({ scope: v, ticker: '' })} options={[['active', 'Vigentes · 48 h'], ['history', 'Historial']]} />
        <Seg label="band" value={band} onChange={(v) => change({ band: v, ticker: '' })} options={[['large', '$10k+'], ['medium', '$5k–$10k'], ['small', '$1k–$5k']]} />
        <Seg label="window" value={win} onChange={(v) => change({ win: v })} options={[['1h', '1 hora'], ['24h', '24 horas'], ['all', 'Todo']]} />
        <Seg label="Posición" value={direction} onChange={(v) => change({ direction: v })} options={[['all', 'Todas'], ['yes', 'Yes · SÍ'], ['no', 'No']]} />
        <span className="ws-filter-note">{scopeText} · {bandText}</span>
        {direction !== 'all' && <span className="ws-filter-note">Solo dirección {direction === 'yes' ? 'YES (SÍ)' : 'NO'} · catálogo, gráficas, flujo, totales y PDF filtrados. Histórico completo e IA sin este filtro.</span>}
      </div>
      <HistoryExport />
      {scope === 'history' && catalog.data && (
        <Notice tone="warn" title="Historial posiblemente incompleto">
          Solo incluye lo que este monitor importó; no garantiza todo el historial de Kalshi. El estado de importación del mercado aparece junto a su gráfica.
        </Notice>
      )}

      <div className="ws-layout">
        <aside className="ws-tree" aria-label="Deporte, partido y mercado">
          <label className="ws-search"><Search size={14} />
            <input value={q} onChange={(e) => change({ q: e.target.value })} placeholder="Buscar deporte, partido o apuesta" aria-label="Buscar mercados" data-testid="input-search-market" />
          </label>
          <div className="ws-tree-scroll">
            {catalog.isLoading && [0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton skeleton-line" style={{ height: 38, margin: '8px 0' }} />)}
            {catalog.isError && !catalog.data && (
              <Notice tone="error" title="No se pudo cargar el catálogo" action={<button className="button secondary" onClick={() => void catalog.refetch()} data-testid="button-retry-catalog"><RefreshCw /> Reintentar</button>}>
                {catalog.error instanceof Error ? catalog.error.message : 'Error desconocido.'}
              </Notice>
            )}
            {markets && grouped.length === 0 && (
              <div className="ws-empty small" data-testid="empty-catalog">
                {q ? 'Ningún mercado coincide con la búsqueda.' : `No hay mercados guardados para este filtro (${band === 'small' ? '$1k–$5k' : band === 'medium' ? 'medianas' : 'grandes'}, ${scope === 'active' ? 'activos' : 'historial'}).`}
              </div>
            )}
            {grouped.map((s) => {
              const sOpen = !!q.trim() || openSports.has(s.sport) || (selected?.sport === s.sport && !openSports.has(`-${s.sport}`));
              return (
                <div key={s.sport} className="ws-sport">
                  <button className="ws-row sport" aria-expanded={sOpen} onClick={() => {
                    const next = new Set(openSports);
                    if (sOpen) { next.delete(s.sport); next.add(`-${s.sport}`); } else { next.add(s.sport); next.delete(`-${s.sport}`); }
                    setOpenSports(next);
                  }} data-testid={`button-sport-${s.sport}`}>
                    <ChevronRight className={sOpen ? 'open' : ''} size={14} />
                    <span className="name">{s.sport}</span><span className="count">{s.trades.toLocaleString('en-US')}</span>
                  </button>
                  {sOpen && s.games.map((g) => {
                    const gOpen = !!q.trim() || openGames.has(g.key) ||
                      (g.markets.some((m) => m.ticker === ticker) && !openGames.has(`-${g.key}`));
                    return (
                      <div key={g.key} className="ws-game">
                        <button className="ws-row game" aria-expanded={gOpen} onClick={() => {
                          const next = new Set(openGames);
                          if (gOpen) { next.delete(g.key); next.add(`-${g.key}`); }
                          else { next.add(g.key); next.delete(`-${g.key}`); }
                          setOpenGames(next);
                        }} data-testid={`button-game-${g.key}`}>
                          <ChevronRight className={gOpen ? 'open' : ''} size={13} />
                          <span className="name">{g.name}<small>{g.date}</small>
                            {scope === 'history' && <small className="ws-history-result">{g.markets.find(m => m.gameResult)?.gameResult ??
                              g.markets.find(m => m.scoreMessage)?.scoreMessage ??
                              (g.markets.every(m => m.scoreStatus === 'unavailable') ? 'Marcador no disponible' : 'Marcador pendiente de cargar')}</small>}
                          </span><span className="count">{g.trades}</span>
                        </button>
                        {gOpen && g.markets.map((m) => (
                          <button key={m.ticker} className={`ws-row market ${m.ticker === ticker ? 'sel' : ''}`} onClick={() => change({ ticker: m.ticker })} aria-current={m.ticker === ticker} data-testid={`button-market-${m.ticker}`}>
                            <span className={`ws-state ${m.state}`}>{STATE_LABEL[m.state]}</span>
                            <span className="name">{m.betLabel}
                            </span><span className="count">{m.trades}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {markets && <div className="ws-tree-foot">{markets.length} mercados · actualizado {fmtTime(catalog.data?.generatedAt ?? '', false)}</div>}
        </aside>

        <div className="ws-main">
          {!ticker && (
            <div className="ws-empty" data-testid="empty-no-selection">
              <h3>Elige un mercado</h3>
              <p>Navega por deporte, partido y apuesta en la columna izquierda. Aquí verás el dinero por intervalo, la cotización SÍ equivalente y cada operación guardada.</p>
            </div>
          )}
          {ticker && !selected && catalog.isLoading && <div className="skeleton" style={{ height: 320 }} />}
          {ticker && selected && (
            <>
              <section className="ws-head">
                <div className="meta">
                  <span className={`ws-state ${selected.state}`}>{STATE_LABEL[selected.state]}</span>
                  <span>{selected.sport}</span><span>{selected.gameDateLabel}</span>
                  <span>{selected.gameTimeLabel ?? 'Hora por confirmar'}</span>
                </div>
                <h2>{selected.gameName}</h2>
                <p className="bet">{selected.betLabel}</p>
                {scope === 'history' && <div className="ws-result" data-testid="historical-result">
                  <p><strong>Marcador final</strong><br />{selected.gameResult ??
                    selected.scoreMessage ??
                    (selected.scoreStatus === 'unavailable' ? 'Marcador no disponible en la fuente' : 'Marcador pendiente de cargar')}</p>
                </div>}
                <div className="links">
                  <span className="mono">{selected.ticker}</span>
                  {selected.marketUrl && <a href={selected.marketUrl} target="_blank" rel="noreferrer" className="trade-link" data-testid="link-selected-market">Abrir en Kalshi <ExternalLink /></a>}
                </div>
              </section>

              <GameAnalysisPanel key={selected.ticker} ticker={selected.ticker} />
              <div className="ws-live" data-testid="live-bar">
                {scope === 'active' ? (
                  <span className={`ws-live-state ${paused ? 'paused' : liveStatus}`} data-testid="status-live">
                    <i />{paused ? 'En pausa: vista congelada' : catalog.data?.workersPaused ? 'Monitor de desarrollo en pausa' : liveStatus === 'open' ? 'Conectado al servidor' : liveStatus === 'connecting' ? 'Conectando' : 'Reconectando; respaldo cada 30 s'}
                  </span>
                ) : <span className="ws-live-state static" data-testid="status-live"><i />Historial estático</span>}
                <span data-testid="text-last-execution">Última ejecución: {lastExec ? fmtTime(lastExec) : 'sin operaciones'}</span>
                {dData && <span>Datos de {fmtTime(dData.generatedAt)}</span>}
                {scope === 'active' && (
                  <button type="button" className="button secondary" onClick={togglePause} disabled={!dData && !paused} data-testid="button-toggle-pause">
                    {paused ? <><Play /> Reanudar</> : <><Pause /> Pausar</>}
                  </button>
                )}
              </div>
              {detail.isLoading && !paused && <div className="skeleton" style={{ height: 300 }} data-testid="loading-detail" />}
              {detail.isError && !dData && (
                <Notice tone="error" title="No se pudieron cargar las operaciones" action={<button className="button secondary" onClick={() => void detail.refetch()} data-testid="button-retry-detail"><RefreshCw /> Reintentar</button>}>
                  {detail.error instanceof Error ? detail.error.message : 'Error desconocido.'}
                </Notice>
              )}
              {dData && (
                <>
                  <div className="ws-kpis">
                    <div><span>Operaciones en la ventana</span><b data-testid="text-window-trades">{dData.totalTrades.toLocaleString('en-US')}</b><small>{win === 'all' ? 'todo lo guardado' : win === '1h' ? 'última hora' : 'últimas 24 horas'}</small></div>
                    <div><span>Dinero total</span><b>{usd(grand)}</b><small>{trades.length.toLocaleString('en-US')} cargadas</small></div>
                    {(['yes', 'no'] as Dir[]).map((d) => (
                      <div key={d}><span><i className="ws-dot" style={{ background: COLORS[d] }} /> {DIR_LABEL[d]}</span><b>{usd(totals[d])}</b><small>{grand ? Math.round((totals[d] / grand) * 100) : 0}% · {DIR_MEANING[d]}</small></div>
                    ))}
                    {totals.unknown > 0 && <div><span><i className="ws-dot" style={{ background: COLORS.unknown }} /> Sin dato</span><b>{usd(totals.unknown)}</b><small>{DIR_MEANING.unknown}</small></div>}
                  </div>
                  <MarketFlow key={selKey} flow={dData.flow} band={band} scope={scope} />
                  <p className="ws-sub">Dirección pública, no ventas ni cierres confirmados: comprar SÍ o vender NO equivale a apostar a favor; comprar NO o vender SÍ, en contra. No identifica al operador.</p>
                  {trades.length === 0 ? (
                    <div className="ws-empty" data-testid="empty-market-trades">
                      <h3>Sin operaciones en esta ventana</h3>
                      <p>{win === 'all' ? 'No hay operaciones guardadas para este mercado en esta banda.' : 'Prueba con una ventana más amplia; el catálogo no cambia.'}</p>
                    </div>
                  ) : (
                    <>
                      <Charts trades={trades} scope={scope} now={now} truncated={dData.truncated} total={dData.totalTrades} fresh={freshIds} />
                      <TradeTable key={selKey} direction={direction} trades={trades} now={now} highlight={scope === 'active'} fresh={freshIds} report={{
                        market: selected,
                        bandLabel: band === 'small' ? '$1,000 a $5,000 (incluidos)' : band === 'medium' ? 'Más de $5,000 y menos de $10,000' : '$10,000+ (umbral configurado)',
                        windowLabel: win === 'all' ? 'Todo lo guardado' : win === '1h' ? 'Última hora' : 'Últimas 24 horas',
                        scopeLabel: scope === 'active' ? 'Vigentes - 48 h' : 'Historial',
                        loadedCount: trades.length,
                        totalCount: dData.totalTrades,
                        truncated: dData.truncated,
                        historyStatus: dData.historyStatus,
                        generatedAt: dData.generatedAt,
                      }} />
                    </>
                  )}
                </>
              )}
              {detail.isFetching && !detail.isLoading && !paused && <div className="ws-refresh"><AlertCircle size={12} /> Actualizando</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
