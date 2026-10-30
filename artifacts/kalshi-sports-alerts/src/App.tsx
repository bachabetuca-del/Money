import { lazy, Suspense, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  ArrowUpRight,
  Bell,
  Check,
  CircleHelp,
  Clock3,
  ExternalLink,
  Eye,
  LoaderCircle,
  MessageCircle,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Signal,
  Volleyball,
} from 'lucide-react';
import {
  getGetKalshiDashboardQueryKey,
  useFindTelegramChat,
  useGetKalshiDashboard,
  useSaveKalshiSettings,
  useSendTelegramTest,
} from '@workspace/api-client-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import type { ReactNode } from 'react';
import { setUrlParams } from '@/lib/navigation';
import { errorText } from '@/components/history-export';
import { UserButton } from '@clerk/react';
import { OwnerAuthProvider, ClearOwnerCache, OwnerLanding, RequireSignIn, OwnerSignIn, OwnerSignUp } from '@/components/owner-access';

const queryClient = new QueryClient();
const Explorer = lazy(() => import('@/components/explorer').then(m => ({ default: m.Explorer })));
const RoiLeaderboard = lazy(() => import('@/components/roi-leaderboard').then(m => ({ default: m.RoiLeaderboard })));
const MAX_NOTIONAL = 999_999_999_999.99;

function money(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: string | null) {
  if (!value) return 'Sin comprobar todavía';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date) + ' ET';
}

function LoadingDashboard() {
  return (
    <>
      <div className="stats-grid" aria-label="Loading dashboard">
        {[0, 1, 2].map((item) => (
          <div className="stat-card" key={item}>
            <div className="skeleton skeleton-line" style={{ width: '42%' }} />
            <div className="skeleton skeleton-line" style={{ width: '58%', height: 28, marginTop: 16 }} />
          </div>
        ))}
      </div>
      <div className="main-grid">
        <div className="panel">
          <div className="panel-head"><div className="skeleton skeleton-line" style={{ width: 150 }} /></div>
          <div className="section-body">
            <div className="skeleton skeleton-line" style={{ width: '55%', height: 38 }} />
            <div className="skeleton skeleton-line" style={{ width: '100%', height: 42, marginTop: 24 }} />
            <div className="skeleton skeleton-line" style={{ width: '100%', height: 42, marginTop: 20 }} />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><div className="skeleton skeleton-line" style={{ width: 140 }} /></div>
          <div className="section-body"><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line" /></div>
        </div>
      </div>
    </>
  );
}

function Home() {
  const queryClient = useQueryClient();
  const { data: dashboard, isLoading, isError, error, refetch, isFetching } = useGetKalshiDashboard({
    query: { refetchInterval: 15000, retry: false },
  });
  const saveSettings = useSaveKalshiSettings({ mutation: {
    onMutate: () => queryClient.cancelQueries({ queryKey: getGetKalshiDashboardQueryKey() }),
  } });
  const findChat = useFindTelegramChat();
  const sendTest = useSendTelegramTest();

  const [enabled, setEnabled] = useState(false);
  const [minimumNotional, setMinimumNotional] = useState('1000');
  const [chatId, setChatId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [findMessage, setFindMessage] = useState('');
  const [findError, setFindError] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [testError, setTestError] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [tab, setTab] = useState<'analysis' | 'settings' | 'leaderboard'>(() => { const t = new URLSearchParams(window.location.search).get('tab'); return t === 'settings' || t === 'leaderboard' ? t : 'analysis'; });
  function pickTab(next: 'analysis' | 'settings' | 'leaderboard') { setTab(next); setUrlParams({ tab: next === 'analysis' ? null : next }); }

  useEffect(() => {
    if (!dashboard || dirty || saveSettings.isPending) return;
    setEnabled(dashboard.enabled);
    setMinimumNotional(String(dashboard.minimumNotional));
    setChatId(dashboard.chatId ?? '');
  }, [dashboard, dirty, saveSettings.isPending]);

  const minimumValue = Number(minimumNotional);
  const validMinimum = minimumNotional.trim() !== '' && Number.isFinite(minimumValue) && minimumValue >= 1 && minimumValue <= MAX_NOTIONAL;
  const canSave = validMinimum && chatId.trim().length > 0 && dirty;

  function discardSettings() {
    if (!dashboard) return;
    setEnabled(dashboard.enabled);
    setMinimumNotional(String(dashboard.minimumNotional));
    setChatId(dashboard.chatId ?? '');
    setDirty(false);
    setSavedMessage('');
    saveSettings.reset();
  }

  function persistSettings() {
    if (!canSave || saveSettings.isPending) return;
    setSavedMessage('');
    saveSettings.mutate(
      { data: { enabled, minimumNotional: minimumValue, chatId: chatId.trim() } },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetKalshiDashboardQueryKey(), updated);
          setEnabled(updated.enabled);
          setMinimumNotional(String(updated.minimumNotional));
          setChatId(updated.chatId ?? '');
          setDirty(false);
          // Cached views use the configured threshold even though it is not a URL filter.
          for (const key of ['/api/kalshi/explorer', '/api/kalshi/leaderboard']) {
            void queryClient.invalidateQueries({ queryKey: [key] });
            queryClient.removeQueries({ queryKey: [key], type: 'inactive' });
          }
          setSavedMessage(updated.workersPaused ? 'Ajustes guardados en desarrollo. El bot publicado no cambió.' : 'Ajustes guardados.');
        },
      },
    );
  }

  function lookupChat() {
    setFindMessage('');
    setFindError(false);
    findChat.mutate(undefined, {
      onSuccess: (result) => {
        setFindMessage(result.message);
        if (result.found && result.chatId && result.chatId !== chatId) { setChatId(result.chatId); setDirty(true); }
        setFindError(!result.found);
      },
      onError: (lookupError) => {
        setFindMessage(lookupError instanceof Error ? lookupError.message : 'Could not find a chat right now.');
        setFindError(true);
      },
    });
  }

  function sendTestMessage() {
    if (!chatId.trim() || dashboard?.workersPaused || sendTest.isPending) return;
    setTestMessage('');
    setTestError(false);
    sendTest.mutate(
      { data: { chatId: chatId.trim() } },
      {
        onSuccess: (result) => {
          setTestMessage(result.message);
          setTestError(!result.success);
        },
        onError: (testSendError) => {
          setTestMessage(testSendError instanceof Error ? testSendError.message : 'The Telegram dashboard could not be refreshed.');
          setTestError(true);
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="app-shell">
        <Header />
        <main className="page-wrap">
          <LoadingDashboard />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Header />
      <main className="page-wrap">
        {isError && (
          <div className="error-box" role="alert" data-testid="status-dashboard-error">
            <div className="error-copy">
              <strong>No se pudo acceder al panel</strong>
              <p>{error instanceof Error ? error.message : 'The monitor could not load its latest status.'}</p>
            </div>
            <button className="button secondary" onClick={() => void refetch()} data-testid="button-retry-dashboard">
              <RefreshCw size={14} /> Reintentar
            </button>
          </div>
        )}

        {dashboard && (
          <>
            {dashboard.workersPaused && <div className="ws-notice" role="status" data-testid="notice-development">
              <div><strong>Vista de desarrollo · bot en pausa</strong><p>Los datos de este entorno pueden ser antiguos. Telegram sigue funcionando solo en la versión publicada. Guardar ajustes aquí no cambia el bot 24/7.</p></div>
            </div>}
            {dashboard.lastError && (
              <div className="error-box" role="status" data-testid="status-monitor-error">
                <div>
                  <strong>Monitor reported an issue</strong>
                  <p>{dashboard.lastError}</p>
                </div>
                <AlertCircle size={18} />
              </div>
            )}
            <section className="stats-grid" aria-label="Resumen global del monitor">
              <div className="stat-card">
                <div className="stat-label">Umbral principal configurado</div>
                <div className="stat-value" data-testid="text-minimum-notional">{money(dashboard.minimumNotional)}</div>
                <div className="stat-foot">Por operación · precio × contratos</div>
                <div className="stat-glyph"><ArrowDownUp /></div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Operaciones guardadas · global</div>
                <div className="stat-value" data-testid="text-qualifying-trades">{dashboard.qualifyingTrades.toLocaleString()}</div>
                <div className="stat-foot">Desde el umbral principal · todos los partidos</div>
                <div className="stat-glyph"><Activity /></div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Operaciones publicadas · global</div>
                <div className="stat-value" data-testid="text-alerts-sent">{dashboard.alertsSent.toLocaleString()}</div>
                <div className="stat-foot">Histórico disponible en el panel de Telegram</div>
                <div className="stat-glyph"><Bell /></div>
              </div>
            </section>

            <nav className="ws-tabs" aria-label="Secciones">
              <button className={tab === 'analysis' ? 'on' : ''} onClick={() => pickTab('analysis')} data-testid="tab-analysis">Análisis de mercados</button>
              <button className={tab === 'settings' ? 'on' : ''} onClick={() => pickTab('settings')} data-testid="tab-settings">Ajustes y Telegram</button>
              <button className={tab === 'leaderboard' ? 'on' : ''} onClick={() => pickTab('leaderboard')} data-testid="tab-leaderboard">Ranking ROI</button>
            </nav>

            <Suspense fallback={<div className="ws-empty" role="status"><LoaderCircle className="spin" size={20} /><p>Cargando sección…</p></div>}>
              {tab === 'analysis' && <Explorer />}
              {tab === 'leaderboard' && <RoiLeaderboard />}
            </Suspense>

            {tab === 'settings' && <div className="main-grid">
              <section className="panel" aria-labelledby="monitor-settings-heading">
                <div className="panel-head">
                  <div>
                    <div className="panel-title" id="monitor-settings-heading"><Radio /> Ajustes del monitor</div>
                    <div className="panel-subtitle">Configura el umbral principal y consulta el estado de Telegram.</div>
                  </div>
                  <div className="time-text" title="El panel se actualiza automáticamente">
                    {isFetching ? 'Actualizando…' : dateTime(dashboard.lastChecked)}
                  </div>
                </div>
                <div className="section-body">
                  <div className="status-row">
                    <div className="monitor-state">
                      <span className={`state-orb ${dashboard.enabled && !dashboard.workersPaused ? '' : 'off'}`}><Signal /></span>
                      <div>
                        <div className="state-name" data-testid="status-monitor">{dashboard.workersPaused ? 'Desarrollo en pausa' : dashboard.enabled ? 'Monitor activado' : 'Monitor en pausa'}</div>
                        <div className="state-detail">{dirty ? 'Tienes cambios sin guardar' : 'Configuración guardada'} · {dashboard.workersPaused ? 'Sin conexiones de Telegram aquí' : dashboard.status}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label="Activar monitor deportivo"
                      disabled={saveSettings.isPending}
                      className={`switch ${enabled ? 'on' : ''}`}
                      onClick={() => { setEnabled(!enabled); setDirty(true); setSavedMessage(''); }}
                      data-testid="toggle-monitor"
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>

                  <div className="setting-field">
                    <label className="field-label" htmlFor="notional-input">
                      Umbral principal por operación
                      <span className="field-help">USD · precio × contratos</span>
                    </label>
                    <div className="input-wrap">
                      <span className="input-prefix">$</span>
                      <input
                        id="notional-input"
                        type="number"
                        min="1"
                        max={MAX_NOTIONAL}
                        step="100"
                        disabled={saveSettings.isPending}
                        aria-invalid={!validMinimum}
                        aria-describedby="notional-help"
                        value={minimumNotional}
                        onChange={(event) => { setMinimumNotional(event.target.value); setDirty(true); setSavedMessage(''); }}
                        data-testid="input-minimum-notional"
                      />
                    </div>
                    <div id="notional-help" className={`small-note ${validMinimum ? '' : 'err'}`} style={{ marginTop: 7 }}>
                      {validMinimum ? 'Las bandas menores conservan su propio rango. La sección grande nunca baja de $10,000 y los avisos requieren superar $10,000.' : 'Introduce un importe válido entre $1 y $999,999,999,999.99.'}
                    </div>
                  </div>

                  <div className="setting-field">
                    <label className="field-label" htmlFor="chat-id-input">
                      Chat de Telegram
                      <span className="field-help">{dashboard.telegramConfigured ? 'Destino configurado' : 'Necesario para los avisos'}</span>
                    </label>
                    <div className="input-wrap">
                      <MessageCircle size={15} color="#78837d" />
                      <input
                        id="chat-id-input"
                        type="text"
                        value={chatId}
                        readOnly
                        aria-readonly="true"
                        onChange={(event) => { setChatId(event.target.value); setSavedMessage(''); }}
                        placeholder="Comprueba la vinculación abajo"
                        autoComplete="off"
                        data-testid="input-telegram-chat-id"
                      />
                    </div>
                    <div className="small-note">Destino exclusivo del propietario. /start no puede cambiarlo.</div>
                  </div>

                  <div className="save-row">
                    <span className="small-note" role="status" data-testid="status-settings-saved">
                      {savedMessage || (saveSettings.isError ? errorText(saveSettings.error, 'No se guardaron los ajustes. Reintenta.') : dirty ? 'Cambios sin guardar.' : 'No hay cambios pendientes.')}
                    </span>
                    {dirty && <button className="button secondary" disabled={saveSettings.isPending} onClick={discardSettings} data-testid="button-discard-settings">Descartar</button>}
                    <button
                      className="button"
                      onClick={persistSettings}
                      disabled={!canSave || saveSettings.isPending}
                      data-testid="button-save-settings"
                    >
                      {saveSettings.isPending ? <LoaderCircle className="spin" /> : <Save />}
                      {saveSettings.isPending ? 'Guardando…' : 'Guardar ajustes'}
                    </button>
                  </div>

                  <div className="telegram-card">
                    <div className="telegram-top">
                      <div className="tg-mark"><span className="tg-icon"><MessageCircle /></span> Avisos de Telegram</div>
                      <span className={`connection-tag ${dashboard.telegramConfigured ? 'connected' : ''}`} data-testid="status-telegram">
                        {dashboard.telegramConfigured ? 'Configurado' : 'Falta configurar'}
                      </span>
                    </div>
                    <p className="setup-copy">
                      {dashboard.telegramConfigured
                        ? <>Navega por Deporte → Partido → Mercado. La gráfica se actualiza en el mismo mensaje. Solo las operaciones nuevas mayores a $10,000 generan avisos y se conserva únicamente el último.</>
                        : <>Abre tu bot en Telegram y envía <strong>/start</strong>. Después comprueba la vinculación del chat.</>}
                    </p>
                    {!dashboard.telegramConfigured && (
                      <div className="steps" aria-label="Telegram setup steps">
                        <div className="step"><b>1</b>Abrir bot</div>
                        <div className="step"><b>2</b>Enviar /start</div>
                        <div className="step"><b>3</b>Comprobar chat</div>
                      </div>
                    )}
                    <div className="telegram-actions">
                      <button
                        className="button secondary"
                        onClick={lookupChat}
                        disabled={findChat.isPending}
                        data-testid="button-find-telegram-chat"
                      >
                        {findChat.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />}
                        {findChat.isPending ? 'Comprobando…' : 'Comprobar chat'}
                      </button>
                      <button
                        className="button ghost"
                        onClick={sendTestMessage}
                        disabled={!chatId.trim() || sendTest.isPending || dashboard.workersPaused}
                        title={dashboard.workersPaused ? 'Usa esta función en el website publicado' : undefined}
                        data-testid="button-send-test"
                      >
                        {sendTest.isPending ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
                        {sendTest.isPending ? 'Actualizando…' : 'Actualizar menú de Telegram'}
                      </button>
                    </div>
                    {dashboard.workersPaused && <p className="small-note">La actualización de Telegram está desactivada aquí para no interferir con el bot publicado.</p>}
                    {findMessage && <div className={`feedback ${findError ? 'error' : ''}`} role="status" data-testid="status-chat-lookup">{findMessage}</div>}
                    {testMessage && <div className={`feedback ${testError ? 'error' : ''}`} role="status" data-testid="status-telegram-test">{testMessage}</div>}
                    {findChat.isError && !findMessage && <div className="feedback error" role="alert">Could not find a chat. Confirm /start was sent, then try again.</div>}
                    {sendTest.isError && !testMessage && <div className="feedback error" role="alert">The Telegram dashboard could not be refreshed. Check the chat ID and try again.</div>}
                  </div>
                </div>
              </section>

              <div>
                <section className="panel" aria-labelledby="signal-notes-heading">
                  <div className="panel-head">
                    <div>
                      <div className="panel-title" id="signal-notes-heading"><ShieldCheck /> Signal, not surveillance</div>
                      <div className="panel-subtitle">What this monitor can — and cannot — tell you.</div>
                    </div>
                  </div>
                  <div className="section-body" style={{ paddingBottom: 17 }}>
                    <div className="notice" style={{ marginTop: 0 }}>
                      <Eye />
                      <span><strong>Public market data only.</strong> The public feed cannot identify the buyer or reveal private account activity.</span>
                    </div>
                    <div className="notice">
                      <ArrowDownUp />
                      <span>Notional is the value of one trade: <strong>trade price × contract count.</strong> It is not an account's total purchase history.</span>
                    </div>
                  </div>
                </section>
                <div className="notice">
                  <CircleHelp />
                  <span>Large trades are a signal to investigate, not a prediction or endorsement. Always review the market context.</span>
                </div>
              </div>
            </div>}

            {tab === 'settings' && <section className="panel activity-panel" aria-labelledby="recent-trades-heading">
              <div className="panel-head">
                <div>
                  <div className="panel-title" id="recent-trades-heading"><Activity /> Actividad global reciente · sin filtros del análisis</div>
                  <div className="panel-subtitle">Public sports-market executions meeting your threshold.</div>
                </div>
                <div className="activity-meta"><span className="count-chip" data-testid="text-recent-trade-count">{dashboard.recentTrades.length}</span> recent</div>
              </div>
              {dashboard.recentTrades.length === 0 ? (
                <div className="empty-state" data-testid="empty-recent-trades">
                  <div className="empty-graphic"><Clock3 /></div>
                  <h3>No matching trades yet</h3>
                  <p>When an individual public sports-market trade meets your notional threshold, it will appear here. The feed is checked automatically.</p>
                </div>
              ) : (
                <div className="trade-list">
                  {dashboard.recentTrades.map((trade) => (
                    <article className="trade-row" key={trade.tradeId} data-testid={`row-trade-${trade.tradeId}`}>
                      <div className="trade-lead">
                        <span className="sport-mark"><Volleyball /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="trade-title">{trade.title}</div>
                          <div className="trade-sub">{trade.sport} <span aria-hidden="true">/</span> {trade.ticker}</div>
                          <div className="trade-bottom">
                            <span className="trade-badge">{trade.outcomeSide} · {trade.bookSide}</span>
                            <span className="trade-badge">{Math.round(trade.price * 100)}¢ · {trade.count.toLocaleString()} contracts</span>
                            {trade.blockTrade && <span className="trade-badge block">Block trade</span>}
                            {trade.marketUrl && (
                              <a className="trade-link" href={trade.marketUrl} target="_blank" rel="noreferrer" data-testid={`link-market-${trade.tradeId}`}>
                                Market <ExternalLink />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="trade-amount">
                        <div className="amount" data-testid={`text-notional-${trade.tradeId}`}>{money(trade.notional)}</div>
                        <div className="amount-label">{dateTime(trade.createdTime)}</div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>}
            <footer className="footer">
              <span>Kalshi sports alerts <span aria-hidden="true">·</span> public market activity</span>
              <span>Updated {dateTime(dashboard.lastChecked)}{isFetching ? ' · refreshing' : ''}</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><Activity /></span>
        <span>Fieldnote <span style={{ color: '#8c9690', fontWeight: 500 }}>/ Kalshi</span></span>
      </div>
      <div className="top-meta">
        <UserButton />
        <span className="meta-refresh">SPORTS FLOW MONITOR</span>
        <span className="live-pill"><i className="live-dot" /> Public feed</span>
      </div>
    </header>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={OwnerLanding} />
        <Route path="/sign-in/*?" component={OwnerSignIn} />
        <Route path="/sign-up/*?" component={OwnerSignUp} />
        <Route path="/dashboard">{() => <RequireSignIn><Home /></RequireSignIn>}</Route>
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <OwnerAuthProvider>
            <ClearOwnerCache />
            <Router />
          </OwnerAuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
