import { useEffect, useState } from 'react';
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
import { Explorer, setUrlParams } from '@/components/explorer';
import { RoiLeaderboard } from '@/components/roi-leaderboard';
import { UserButton } from '@clerk/react';
import { OwnerAuthProvider, ClearOwnerCache, OwnerLanding, RequireSignIn, OwnerSignIn, OwnerSignUp } from '@/components/owner-access';

const queryClient = new QueryClient();

function money(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: string | null) {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
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
  const saveSettings = useSaveKalshiSettings();
  const findChat = useFindTelegramChat();
  const sendTest = useSendTelegramTest();

  const [enabled, setEnabled] = useState(false);
  const [minimumNotional, setMinimumNotional] = useState('1000');
  const [chatId, setChatId] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [findMessage, setFindMessage] = useState('');
  const [findError, setFindError] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const [testError, setTestError] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [tab, setTab] = useState<'analysis' | 'settings' | 'leaderboard'>(() => { const t = new URLSearchParams(window.location.search).get('tab'); return t === 'settings' || t === 'leaderboard' ? t : 'analysis'; });
  function pickTab(next: 'analysis' | 'settings' | 'leaderboard') { setTab(next); setUrlParams({ tab: next === 'analysis' ? null : next }); }

  useEffect(() => {
    if (!dashboard) return;
    if (!initialized) {
      setEnabled(dashboard.enabled);
      setMinimumNotional(String(dashboard.minimumNotional));
      setChatId(dashboard.chatId ?? '');
      setInitialized(true);
      return;
    }
    if (!chatId.trim() && dashboard.chatId) {
      setChatId(dashboard.chatId);
    }
  }, [dashboard, initialized, chatId]);

  const minimumValue = Number(minimumNotional);
  const canSave = Number.isFinite(minimumValue) && minimumValue >= 1 && chatId.trim().length > 0;

  function persistSettings() {
    if (!canSave) return;
    setSavedMessage('');
    saveSettings.mutate(
      { data: { enabled, minimumNotional: minimumValue, chatId: chatId.trim() } },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetKalshiDashboardQueryKey(), updated);
          setSavedMessage('Monitor settings saved.');
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
        if (result.found && result.chatId) setChatId(result.chatId);
        setFindError(!result.found);
      },
      onError: (lookupError) => {
        setFindMessage(lookupError instanceof Error ? lookupError.message : 'Could not find a chat right now.');
        setFindError(true);
      },
    });
  }

  function sendTestMessage() {
    if (!chatId.trim()) return;
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
              <strong>Dashboard access unavailable</strong>
              <p>{error instanceof Error ? error.message : 'The monitor could not load its latest status.'}</p>
            </div>
            <button className="button secondary" onClick={() => void refetch()} data-testid="button-retry-dashboard">
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        )}

        {dashboard && (
          <>
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

            {tab === 'analysis' && <Explorer />}

            {tab === 'leaderboard' && <RoiLeaderboard />}

            {tab === 'settings' && <div className="main-grid">
              <section className="panel" aria-labelledby="monitor-settings-heading">
                <div className="panel-head">
                  <div>
                    <div className="panel-title" id="monitor-settings-heading"><Radio /> Monitor settings</div>
                    <div className="panel-subtitle">Tune the public sports-trade signal.</div>
                  </div>
                  <div className="time-text" title="Dashboard refreshes automatically">
                    {isFetching ? 'Updating…' : `Checked ${dateTime(dashboard.lastChecked)}`}
                  </div>
                </div>
                <div className="section-body">
                  <div className="status-row">
                    <div className="monitor-state">
                      <span className={`state-orb ${enabled ? '' : 'off'}`}><Signal /></span>
                      <div>
                        <div className="state-name" data-testid="status-monitor">{enabled ? 'Monitoring is on' : 'Monitoring is paused'}</div>
                        <div className="state-detail">Service status: {dashboard.status}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label="Enable sports trade monitoring"
                      className={`switch ${enabled ? 'on' : ''}`}
                      onClick={() => { setEnabled(!enabled); setSavedMessage(''); }}
                      data-testid="toggle-monitor"
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>

                  <div className="setting-field">
                    <label className="field-label" htmlFor="notional-input">
                      Minimum trade notional
                      <span className="field-help">USD · single execution</span>
                    </label>
                    <div className="input-wrap">
                      <span className="input-prefix">$</span>
                      <input
                        id="notional-input"
                        type="number"
                        min="1"
                        step="100"
                        value={minimumNotional}
                        onChange={(event) => { setMinimumNotional(event.target.value); setSavedMessage(''); }}
                        data-testid="input-minimum-notional"
                      />
                    </div>
                    <div className="small-note" style={{ marginTop: 7 }}>Only individual public trades at or above this amount qualify.</div>
                  </div>

                  <div className="setting-field">
                    <label className="field-label" htmlFor="chat-id-input">
                      Telegram chat ID
                      <span className="field-help">{dashboard.telegramConfigured ? 'Destination configured' : 'Required to deliver alerts'}</span>
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
                        placeholder="Find it with the setup below"
                        autoComplete="off"
                        data-testid="input-telegram-chat-id"
                      />
                    </div>
                    <div className="small-note">Owner-locked destination. Telegram /start cannot change it.</div>
                  </div>

                  <div className="save-row">
                    <span className="small-note" data-testid="status-settings-saved">
                      {savedMessage || (saveSettings.isError ? 'Settings did not save. Check the connection and retry.' : 'Changes apply after you save.')}
                    </span>
                    <button
                      className="button"
                      onClick={persistSettings}
                      disabled={!canSave || saveSettings.isPending}
                      data-testid="button-save-settings"
                    >
                      {saveSettings.isPending ? <LoaderCircle className="spin" /> : <Save />}
                      {saveSettings.isPending ? 'Saving' : 'Save settings'}
                    </button>
                  </div>

                  <div className="telegram-card">
                    <div className="telegram-top">
                      <div className="tg-mark"><span className="tg-icon"><MessageCircle /></span> Telegram delivery</div>
                      <span className={`connection-tag ${dashboard.telegramConfigured ? 'connected' : ''}`} data-testid="status-telegram">
                        {dashboard.telegramConfigured ? 'Configured' : 'Setup required'}
                      </span>
                    </div>
                    <p className="setup-copy">
                      {dashboard.telegramConfigured
                        ? <>Your live dashboard is connected. Choose a section, then Sport → Game → Market. The graph updates in place. Only new trades over $10,000 send notifications; only the latest notice is kept.</>
                        : <>Open your bot in Telegram and send <strong>/start</strong> first. Then find the chat to link this monitor.</>}
                    </p>
                    {!dashboard.telegramConfigured && (
                      <div className="steps" aria-label="Telegram setup steps">
                        <div className="step"><b>1</b>Open bot</div>
                        <div className="step"><b>2</b>Send /start</div>
                        <div className="step"><b>3</b>Find chat</div>
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
                        {findChat.isPending ? 'Looking…' : 'Find Telegram chat'}
                      </button>
                      <button
                        className="button ghost"
                        onClick={sendTestMessage}
                        disabled={!chatId.trim() || sendTest.isPending}
                        data-testid="button-send-test"
                      >
                        {sendTest.isPending ? <LoaderCircle className="spin" /> : <ArrowUpRight />}
                        {sendTest.isPending ? 'Refreshing…' : 'Refresh Telegram menu'}
                      </button>
                    </div>
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
