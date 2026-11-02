import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, MessageCircle, RefreshCw, Search, X } from 'lucide-react';
import {
  getGetKalshiNotificationsQueryKey,
  useGetKalshiNotifications,
  type GetKalshiNotificationsParams,
  type TelegramNotice,
  type TelegramNotices as Notices,
} from '@workspace/api-client-react';
import { setUrlParams } from '../lib/navigation';
import { errorText } from './history-export';
import {
  contractsText, etTime, noticeGameView, priceCents, roiView, safeKalshiUrl, sideLabel, sportName, usd,
} from '../lib/notice-format';
import './telegram-notices.css';

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  const page = Math.max(1, Math.min(100000, Number.parseInt(p.get('npage') ?? '1', 10) || 1));
  return { page, q: (p.get('nq') ?? '').slice(0, 120), sport: (p.get('nsport') || 'all').slice(0, 80) };
}

export function NoticeCard({ notice, now }: { notice: TelegramNotice; now?: number }) {
  const roi = roiView(notice.roi);
  const link = safeKalshiUrl(notice.marketUrl);
  const game = noticeGameView(notice.game, now);
  const id = notice.tradeId;
  return (
    <article className="tn-card" data-testid={`card-notice-${id}`}>
      <div className="tn-top">
        <span className="tn-sport" data-testid={`text-sport-${id}`}>{sportName(notice.sport)}</span>
        <span className="tn-sent" data-testid={`text-sent-${id}`}>Enviado {etTime(notice.sentAt)}</span>
      </div>
      <h3 className="tn-game" data-testid={`text-game-${id}`}>{notice.eventTitle || 'Partido no registrado'}</h3>
      <p className="tn-bet" data-testid={`text-bet-${id}`}>{notice.marketTitle || 'Apuesta no registrada'}</p>

      <div className="tn-game-context">
        <div className="tn-kickoff">
          <CalendarDays size={17} aria-hidden="true" />
          <div>
            <span>Inicio programado del partido</span>
            <strong data-testid={`text-game-start-${id}`}>
              {game.startsAt
                ? <time dateTime={game.startsAt}>{game.dateLabel} · {game.timeLabel}</time>
                : <>{game.dateLabel} · {game.timeLabel}</>}
            </strong>
          </div>
        </div>
        <span className={`tn-game-status is-${game.status}`} data-testid={`text-game-status-${id}`}
          aria-label={`Estado del partido: ${game.label}`}>
          <i aria-hidden="true" />{game.label}
        </span>
        {game.delayed && <p className="tn-game-delay">Estado pendiente de actualización; no se confirma que esté en vivo.</p>}
        {game.status === 'market_resolved' && <p className="tn-game-delay">La apuesta está resuelta; no confirma que el partido haya terminado.</p>}
      </div>

      <div className="tn-figures">
        <div className={`tn-fig side-${notice.side}`}>
          <span>Lado y precio observado</span>
          <b data-testid={`text-price-${id}`}><em>{sideLabel(notice.side)}</em> a {priceCents(notice.price)}</b>
          <small>por contrato, del lado seleccionado</small>
        </div>
        <div className={`tn-fig roi ${roi.tone}`}>
          <span data-testid={`text-roi-label-${id}`}>{roi.label}</span>
          <b data-testid={`text-roi-${id}`}>{roi.headline}</b>
          <small>{roi.sample ?? 'Sin muestra histórica guardada'}</small>
        </div>
        <div className="tn-fig">
          <span>Tamaño original</span>
          <b data-testid={`text-notional-${id}`}>{usd(notice.notional)}</b>
          <small>{contractsText(notice.contracts)}</small>
        </div>
      </div>

      <div className="tn-foot">
        {notice.removedFromTelegram && <span className="tn-tag">Ya no está en Telegram · guardado aquí</span>}
        {notice.detailsSource === 'legacy' && <span className="tn-tag muted">Aviso anterior · datos limitados</span>}
        {link ? (
          <a className="tn-link" href={link} target="_blank" rel="noreferrer" data-testid={`link-market-${id}`}>Ver en Kalshi <ArrowUpRight size={13} /></a>
        ) : <span className="tn-tag muted">Sin enlace de mercado</span>}
      </div>

      <details className="tn-more">
        <summary data-testid={`button-details-${id}`}>Más detalle</summary>
        <dl>
          <div><dt>Ejecución observada</dt><dd>{etTime(notice.executedAt)}</dd></div>
          <div><dt>Última comprobación del partido</dt><dd>{etTime(game.checkedAt)}</dd></div>
          {roi.other && <div><dt>Otra base de ROI</dt><dd>{roi.other}</dd></div>}
          {notice.roi && <div><dt>Historial hasta</dt><dd>{etTime(notice.roi.historyAsOf)}</dd></div>}
          <div><dt>Ticker</dt><dd className="mono">{notice.ticker}</dd></div>
          <div><dt>Operación</dt><dd className="mono">{notice.tradeId}</dd></div>
        </dl>
      </details>
    </article>
  );
}

function Skeleton() {
  return <div className="tn-list" aria-label="Cargando avisos">{[0, 1, 2].map(i => (
    <div className="tn-card" key={i}>
      <div className="skeleton skeleton-line" style={{ width: 120 }} />
      <div className="skeleton skeleton-line" style={{ width: '70%', height: 22 }} />
      <div className="skeleton skeleton-line" style={{ width: '45%' }} />
      <div className="skeleton" style={{ height: 70, marginTop: 14 }} />
    </div>))}</div>;
}

export function NoticesBody({ data, filtered, onClear }: { data: Notices; filtered: boolean; onClear: () => void }) {
  if (data.rows.length === 0) {
    if (filtered) return <div className="ws-empty" data-testid="empty-notices-filtered"><h3>Ningún aviso coincide</h3><p>La búsqueda cubre los {data.totalDelivered.toLocaleString()} avisos guardados.</p><button className="button secondary" style={{ marginTop: 14 }} onClick={onClear} data-testid="button-clear-filters">Quitar filtros</button></div>;
    if (!data.chatConfigured) return <div className="ws-empty" data-testid="empty-notices-nochat"><h3>Telegram no está vinculado</h3><p>Todavía no hay un chat configurado. Revisa la sección Ajustes y Telegram.</p></div>;
    return <div className="ws-empty" data-testid="empty-notices"><h3>Aún no hay avisos entregados</h3><p>El chat está configurado. Cuando Telegram confirme un aviso, aparecerá aquí con su precio, deporte y ROI.</p></div>;
  }
  return <div className="tn-list">{data.rows.map(n => <NoticeCard key={`${n.tradeId}-${n.sentAt}`} notice={n} />)}</div>;
}

export function TelegramNotices() {
  const [state, setState] = useState(readUrl);
  const [draft, setDraft] = useState(state.q);

  useEffect(() => {
    const onPop = () => { const s = readUrl(); setState(s); setDraft(s.q); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function apply(next: { page: number; q: string; sport: string }) {
    setState(next);
    setUrlParams({ npage: next.page > 1 ? String(next.page) : null, nq: next.q || null, nsport: next.sport !== 'all' ? next.sport : null });
  }
  // A sport/page/back-navigation change cancels the pending search, so its
  // callback can never restore filters captured before that interaction.
  useEffect(() => {
    if (draft.trim() === state.q) return;
    const timer = setTimeout(() => apply({ ...state, q: draft.trim(), page: 1 }), 350);
    return () => clearTimeout(timer);
  }, [draft, state]);

  const params: GetKalshiNotificationsParams = { page: state.page, sport: state.sport };
  if (state.q) params.q = state.q;
  const query = useGetKalshiNotifications(params, {
    query: { queryKey: getGetKalshiNotificationsQueryKey(params), refetchInterval: 30000, retry: 1 },
  });
  const { data, isLoading, isError, error, refetch, isFetching } = query;
  const filtered = !!state.q || state.sport !== 'all';
  const sports = data?.availableSports ?? [];

  return (
    <section className="tn-wrap" aria-labelledby="tn-heading">
      <header className="tn-head">
        <div>
          <div className="eyebrow">Historial de Telegram</div>
          <h2 id="tn-heading"><MessageCircle size={20} /> Avisos entregados</h2>
          <p>Cada aviso confirmado, del más reciente al más antiguo. La fecha y el estado del partido se actualizan; el precio y el ROI conservan los datos originales del aviso. El ROI es histórico, no una ganancia garantizada ni el resultado posterior del partido.</p>
        </div>
        <div className="tn-refresh">
          <span className="ws-refresh" data-testid="status-notices-updated">{isFetching ? 'Actualizando…' : data ? `Actualizado ${etTime(data.generatedAt)}` : ''}</span>
          <button className="button secondary" onClick={() => void refetch()} disabled={isFetching} data-testid="button-refresh-notices"><RefreshCw size={14} className={isFetching ? 'spin' : ''} /> Actualizar</button>
        </div>
      </header>

      {data?.workersPaused && <div className="ws-notice warn" role="status" data-testid="notice-notices-paused"><div><strong>Vista de desarrollo</strong><p>Puede no compartir los datos de producción. Desde aquí no se envía ningún mensaje.</p></div></div>}

      <div className="tn-filters">
        <label className="ws-search tn-search">
          <Search size={14} />
          <span className="sr-only">Buscar avisos</span>
          <input value={draft} maxLength={120} onChange={e => setDraft(e.target.value.slice(0, 120))} placeholder="Buscar equipo, partido, apuesta o ticker" data-testid="input-search-notices" />
          {draft && <button type="button" className="tn-x" aria-label="Borrar búsqueda" onClick={() => { setDraft(''); apply({ ...state, q: '', page: 1 }); }} data-testid="button-clear-search"><X size={13} /></button>}
        </label>
        <label className="ws-type-filter">Deporte
          <select value={state.sport} onChange={e => apply({ ...state, sport: e.target.value, page: 1 })} data-testid="select-sport-notices">
            <option value="all">Todos</option>
            {state.sport !== 'all' && !sports.includes(state.sport) && <option value={state.sport}>{sportName(state.sport)}</option>}
            {sports.map(s => <option key={s} value={s}>{sportName(s)}</option>)}
          </select>
        </label>
        {data && <span className="ws-filter-note" data-testid="text-notices-total">{data.total.toLocaleString()} {filtered ? 'coinciden' : 'avisos'} de {data.totalDelivered.toLocaleString()} guardados</span>}
      </div>

      {isLoading ? <Skeleton /> : isError && !data ? (
        <div className="error-box" role="alert" data-testid="status-notices-error">
          <div><strong>No se pudo cargar el historial</strong><p>{errorText(error, 'Reintenta en unos segundos.')}</p></div>
          <button className="button secondary" onClick={() => void refetch()} data-testid="button-retry-notices"><RefreshCw size={14} /> Reintentar</button>
        </div>
      ) : data ? (
        <>
          {isError && <div className="ws-notice error" role="status"><div><strong>Fallo al actualizar</strong><p>Se muestran los últimos datos cargados para estos filtros.</p></div></div>}
          <NoticesBody data={data} filtered={filtered} onClear={() => { setDraft(''); apply({ page: 1, q: '', sport: 'all' }); }} />
          {data.totalPages > 1 && (
            <nav className="tn-pager" aria-label="Páginas">
              <button className="button secondary" disabled={data.page <= 1} onClick={() => apply({ ...state, page: data.page - 1 })} data-testid="button-prev-notices"><ChevronLeft size={14} /> Más recientes</button>
              <span className="mono" data-testid="text-notices-page">Página {data.page} de {data.totalPages}</span>
              <button className="button secondary" disabled={data.page >= data.totalPages} onClick={() => apply({ ...state, page: data.page + 1 })} data-testid="button-next-notices">Anteriores <ChevronRight size={14} /></button>
            </nav>
          )}
        </>
      ) : null}
    </section>
  );
}
