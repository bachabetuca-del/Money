import { Fragment, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, History, RefreshCw, Snowflake, Target } from 'lucide-react';
import {
  getGetKalshiSignalsQueryKey,
  useGetKalshiSignals,
  type GetKalshiSignalsParams,
  type SignalEvaluation as SignalEvaluationData,
  type SignalOutcome,
  type SignalPerformance,
  type SignalRule,
} from '@workspace/api-client-react';
import { errorText } from '@/components/history-export';
import { PaperValidation } from '@/components/paper-validation';
import './signal-evaluation.css';

const TZ = 'America/New_York';
export function when(v: string | null | undefined, empty = 'sin dato') {
  if (!v) return empty;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('es-US', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' ET';
}
export function pct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  const s = v.toLocaleString('es-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return v > 0 ? `+${s}%` : `${s}%`;
}
export function usd(v: number | null | undefined, sign = true) {
  if (v == null || !Number.isFinite(v)) return null;
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Math.abs(v));
  return v < 0 ? `-${s}` : sign && v > 0 ? `+${s}` : s;
}
const cents = (price: number) => `${(price * 100).toLocaleString('es-US', { maximumFractionDigits: 2 })}¢`;
const preciseUsd = (value: number) => value.toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
});
function tone(v: number | null | undefined) { return v == null ? 'unk' : v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
const n = (v: number) => v.toLocaleString('es-US');

const REC = {
  not_started: { l: 'Registro no iniciado', d: 'El registro empieza automáticamente solo en la versión publicada. Este entorno no registra señales.' },
  active: { l: 'Registrando', d: 'Cada aviso nuevo se congela antes de enviarse y se evalúa con la liquidación oficial posterior.' },
  paused: { l: 'Registro en pausa', d: 'No se están registrando señales nuevas aquí. Se conservan la fecha de inicio y los datos guardados.' },
} as const;
const STATUS: Record<SignalOutcome['status'], string> = { not_sent: 'No enviado', pending: 'Liquidación pendiente', settled: 'Liquidado', excluded: 'Excluido' };
const DELIVERY: Record<SignalOutcome['delivery'], string> = { sent: 'Enviado', pending: 'Envío pendiente', skipped: 'Omitido' };
const EXCL: Record<string, string> = { settled_before_alert: 'Verificado antes del aviso', unsupported_settlement: 'Liquidación no soportada' };

export function ruleText(r: SignalRule) {
  const amount = r.amountMax == null
    ? `${r.amountMinInclusive ? '≥' : '>'} $${n(r.amountMin)}`
    : `${r.amountMinInclusive ? '[' : '('}$${n(r.amountMin)} – $${n(r.amountMax)}${r.amountMaxInclusive ? ']' : ')'}`;
  return {
    amount,
    odds: `${Math.round(r.oddsMin * 100)}–${Math.round(r.oddsMax * 100)}¢ · límite superior ${r.oddsMax === 1 ? 'incluido' : 'excluido'}`,
    filter: `ROI ${r.basis === 'net' ? 'neto est.' : 'bruto'} ≥ ${pct(r.minimumRoiPct)} · ≥ ${r.minimumGames} partidos · ≥ ${r.minimumTrades} entradas · historial ${r.coverage === 'verified' ? 'verificado' : r.coverage} · ventana ${r.window === 'all' ? 'completa' : r.window}${r.roiMethodVersion ? ` · primera entrada por patrón/partido · fase ${r.historicalPhase} · método ${r.roiMethodVersion}` : ' · método original por ejecución'}`,
  };
}

export function SignalEvaluation() {
  const [page, setPage] = useState(1);
  const params: GetKalshiSignalsParams = { page };
  const q = useGetKalshiSignals(params, {
    query: {
      queryKey: getGetKalshiSignalsQueryKey(params),
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      retry: 1,
      placeholderData: keepPreviousData,
    },
  });
  const data = q.data;
  const stale = q.isPlaceholderData;

  return (
    <div className="sg" data-testid="signal-evaluation">
      <section className="sg-head">
        <div>
          <div className="eyebrow">Evaluación hacia delante · solo después del aviso</div>
          <h2>Señales: qué pasó después</h2>
          <p>Compara el ROI histórico que justificó cada aviso (congelado en ese momento) con el resultado simulado posterior, usando liquidaciones oficiales. No es un backtest: solo cuentan avisos confirmados como enviados y liquidados después.</p>
        </div>
        <div className="sg-snap" data-testid="text-signals-snapshot">
          {data && <span className={`sg-rec ${data.recording}`} data-testid="status-recording"><i />{REC[data.recording].l}</span>}
          <span>{q.isFetching ? 'Actualizando…' : data ? `Instantánea ${when(data.generatedAt)}` : 'Sin instantánea'}</span>
          <span>Se actualiza cada 30 s</span>
        </div>
      </section>

      {q.isError && (
        <div className="ws-notice error" role="alert" data-testid="status-signals-error">
          <div><strong>{data ? 'No se pudo actualizar; se muestra la última instantánea' : 'No se pudo cargar la evaluación'}</strong><p>{errorText(q.error, 'Error desconocido.')}</p></div>
          <button className="button secondary" onClick={() => void q.refetch()} data-testid="button-retry-signals"><RefreshCw /> Reintentar</button>
        </div>
      )}

      {q.isLoading && <Loading />}
      {data && <Body data={data} stale={stale} setPage={setPage} />}
      <PaperValidation />
    </div>
  );
}

export function Body({ data, stale, setPage }: { data: SignalEvaluationData; stale: boolean; setPage: (p: number) => void }) {
  const s = data.summary;
  const rec = REC[data.recording];
  return (
    <>
      <div className={`ws-notice ${data.recording === 'active' ? '' : 'warn'}`} role="status" data-testid="text-recording-detail">
        <div>
          <strong>{rec.l}</strong>
          <p>
            {rec.d}{' '}
            {data.activatedAt ? `Inicio de la evaluación: ${when(data.activatedAt)}.` : 'Aún no hay fecha de inicio.'}
            {data.firstSignalAt ? ` Primer aviso registrado ${when(data.firstSignalAt)}; último ${when(data.lastSignalAt)}.` : ' Todavía no hay avisos registrados.'}
            {` Última revisión de liquidaciones: ${when(data.lastSettlementCheckAt, 'ninguna todavía')}.`}
          </p>
        </div>
      </div>

      <Warnings s={s} />

      <div className="sg-split">
        <section className="sg-block frozen" aria-labelledby="sg-hist">
          <h3 id="sg-hist"><Snowflake size={14} /> Antes: criterio histórico congelado</h3>
           <p>Cada aviso guarda el ROI histórico retrospectivo, su muestra y el modelo de costes antes del primer intento de envío. Ese número describe el pasado y no se recalcula en los reintentos. Consúltalo en el detalle de cada fila.</p>
          <div className="sg-kv">
            <div><span>Registrados</span><b data-testid="text-registered">{n(s.registered)}</b><small>avisos que superaron la regla</small></div>
            <div><span>Enviados confirmados</span><b data-testid="text-delivered">{n(s.delivered)}</b><small>{n(s.awaitingDelivery)} esperando envío · {n(s.skipped)} omitidos</small></div>
          </div>
        </section>
        <section className="sg-block" aria-labelledby="sg-after">
          <h3 id="sg-after"><Target size={14} /> Después: resultado simulado</h3>
          <p>$100 por aviso al precio observado (stake igual simulado, no el tamaño de la operación observada), mantenidos hasta la liquidación oficial.</p>
          <Perf s={s} />
        </section>
      </div>

      {data.cohorts.length > 0 && (
        <section className="ws-card" aria-labelledby="sg-cohorts">
          <header><h3 id="sg-cohorts">Grupos por regla y modelo de costes</h3><p>El resumen reúne todos los avisos. Estos grupos permiten distinguir las bases y versiones aplicadas cuando cambian.</p></header>
          <div className="ws-table-wrap">
            <table className="ws-table sg-cohorts" data-testid="table-signal-cohorts">
              <thead><tr><th>Regla</th><th>Base</th><th>Modelo de costes</th><th className="r">Enviados</th><th className="r">Liquidados · partidos</th><th className="r">Pendientes</th><th className="r">G / P</th><th className="r">ROI bruto</th><th className="r">ROI neto est.</th></tr></thead>
              <tbody>
                {data.cohorts.map((c) => {
                  const p = c.performance;
                  const k = `${c.ruleVersion}-${c.basis}-${c.feeModelVersion}`;
                  return (
                    <tr key={k} data-testid={`row-cohort-${k}`}>
                      <td className="mono">{c.ruleVersion}</td><td>{c.basis === 'net' ? 'Neto' : 'Bruto'}</td><td className="mono">{c.feeModelVersion}</td>
                      <td className="r">{n(p.delivered)}</td><td className="r">{n(p.settled)} · {n(p.settledGames)}</td><td className="r">{n(p.pending)}</td>
                      <td className="r">{p.wins} / {p.losses}</td>
                      <td className={`r ${tone(p.grossRoiPct)}`}>{pct(p.grossRoiPct) ?? 'Sin liquidados'}</td>
                      <td className={`r ${tone(p.netRoiPct)}`}>{pct(p.netRoiPct) ?? (p.settled > 0 ? 'Desconocido' : 'Sin liquidados')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className={`ws-card ${stale ? 'stale' : ''}`} aria-busy={stale} aria-labelledby="sg-rows">
        <header className="row">
          <div><h3 id="sg-rows">Avisos registrados</h3><p>Envío pendiente u omitido no es un resultado: nunca cuenta como pérdida.</p></div>
          {stale && <span className="sg-tag pending" data-testid="status-signals-stale">Cargando página…</span>}
        </header>
        {data.rows.length === 0 ? (
          <div className="ws-empty small" data-testid="empty-signals">
            <h3>{data.recording === 'not_started' ? 'Sin registro todavía' : 'Aún no hay avisos registrados'}</h3>
            <p>{data.recording === 'not_started' ? 'Las filas aparecerán cuando el bot de producción registre el primer aviso nuevo que cumpla la regla. No se importan avisos anteriores ni se inventan resultados.' : 'Cuando un aviso nuevo cumpla la regla se congelará aquí con su evidencia original.'}</p>
          </div>
        ) : (
          <>
            <div className="ws-table-wrap" style={{ maxHeight: 'none' }}>
              <table className="ws-table sg-table" data-testid="table-signals">
                <caption className="sr-only">Avisos registrados y su resultado posterior</caption>
                <thead><tr><th>Aviso</th><th>Lado · precio</th><th className="r">ROI histórico (antes)</th><th>Envío</th><th>Estado</th><th className="r">Bruto después</th><th className="r">Neto est. después</th><th /></tr></thead>
                <tbody>{data.rows.map((r) => <Row key={r.evidence.tradeId} r={r} />)}</tbody>
              </table>
            </div>
            <nav className="lb-pager" aria-label="Paginación de avisos" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 12 }}>
              <button className="button secondary" disabled={data.page <= 1 || stale} onClick={() => setPage(Math.max(1, data.page - 1))} data-testid="button-signals-prev"><ChevronLeft /> Anterior</button>
              <span className="mono" data-testid="text-signals-page">Página {data.page} de {Math.max(1, data.totalPages)}</span>
              <button className="button secondary" disabled={data.page >= data.totalPages || stale} onClick={() => setPage(data.page + 1)} data-testid="button-signals-next">Siguiente <ChevronRight /></button>
            </nav>
          </>
        )}
      </section>

      <section className="sg-block" aria-labelledby="sg-limits">
        <h3 id="sg-limits"><History size={14} /> Limitaciones</h3>
        <ul className="sg-limits" data-testid="list-signal-limitations">
          {data.limitations.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      </section>
    </>
  );
}

function Perf({ s }: { s: SignalPerformance }) {
  const netUnknown = s.settled > 0 && s.netRoiPct == null;
  return (
    <>
      <div className="sg-kv">
        <div><span>ROI bruto simulado</span><b className={tone(s.grossRoiPct)} data-testid="text-gross-roi">{pct(s.grossRoiPct) ?? 'Sin liquidados'}</b><small>{usd(s.grossProfit) ?? 'n/d'} sobre {usd(s.invested, false)}</small></div>
        <div><span>ROI neto estimado</span><b className={tone(s.netRoiPct)} data-testid="text-net-roi">{pct(s.netRoiPct) ?? (netUnknown ? 'Desconocido' : 'Sin liquidados')}</b><small>{netUnknown ? `Faltan tarifas en ${n(s.feeMissing)} avisos; no se asumen cero` : s.netOutlay != null ? `${usd(s.netProfit) ?? 'n/d'} sobre ${usd(s.netOutlay, false)} con comisión` : `${n(s.feeCovered)} con tarifa conocida`}</small></div>
        <div><span>Liquidados · pendientes</span><b data-testid="text-settled">{n(s.settled)} · {n(s.pending)}</b><small>{n(s.excluded)} excluidos</small></div>
        <div><span>Partidos</span><b data-testid="text-games">{n(s.settledGames)} / {n(s.games)}</b><small>liquidados / distintos</small></div>
        <div><span>Ganados / perdidos</span><b data-testid="text-wins-losses">{s.wins} / {s.losses}</b><small>solo enviados y liquidados</small></div>
      </div>
    </>
  );
}

function Warnings({ s }: { s: SignalPerformance }) {
  const small = s.settledGames < 10 || s.settled < 30;
  return (
    <div className="sg-warns">
      {s.settled > 0 && small && <div className="ws-notice warn" role="note" data-testid="warning-small-sample"><div><strong><AlertTriangle size={13} /> Muestra pequeña</strong><p>{n(s.settled)} avisos liquidados en {n(s.settledGames)} partidos. Con menos de 10 partidos o 30 avisos, interpreta el resultado con especial cautela; superar esos mínimos tampoco prueba rentabilidad.</p></div></div>}
      {s.settled > s.settledGames && <div className="ws-notice warn" role="note" data-testid="warning-correlated"><div><strong>Avisos correlacionados</strong><p>{n(s.settled)} avisos liquidados comparten solo {n(s.settledGames)} partidos; no son observaciones independientes.</p></div></div>}
      {s.feeMissing > 0 && <div className="ws-notice warn" role="note" data-testid="warning-fee-missing"><div><strong>Tarifas incompletas</strong><p>{n(s.feeMissing)} avisos no tienen tarifa estimable. El neto queda desconocido; nunca se trata como cero.</p></div></div>}
    </div>
  );
}

export function Row({ r }: { r: SignalOutcome }) {
  const [open, setOpen] = useState(false);
  const e = r.evidence;
  const id = `sg-detail-${e.tradeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const isOutcome = r.status === 'settled';
  return (
    <Fragment>
      <tr data-testid={`row-signal-${e.tradeId}`}>
        <td className="wrap"><b style={{ fontSize: 12 }}>{e.eventTitle}</b><br /><small>{e.marketTitle}</small><br /><span className="time-text">{when(e.observedAt)}</span></td>
        <td><span className="sg-tag">{e.rule.side === 'yes' ? 'SÍ' : 'NO'}</span> <span className="mono">{cents(e.price)}</span><br /><small className="mono">{usd(e.notional, false)} observado</small></td>
        <td className="r"><b className={tone(e.historicalRoiPct)}>{pct(e.historicalRoiPct)}</b><br /><small>{e.rule.basis === 'net' ? 'neto est.' : 'bruto'} · {e.historicalGames} part. · {e.historicalTrades} op.</small></td>
        <td><span className="sg-tag">{DELIVERY[r.delivery]}</span>{r.sentAt && <><br /><span className="time-text">{when(r.sentAt)}</span></>}</td>
        <td><span className={`sg-tag ${r.status}`} data-testid={`status-signal-${e.tradeId}`}>{STATUS[r.status]}</span>{r.exclusionReason && <><br /><small>{EXCL[r.exclusionReason] ?? r.exclusionReason}</small></>}{r.settlementError && <><br /><small className="neg">{r.settlementError}</small></>}</td>
        <td className={`r ${isOutcome ? tone(r.grossRoiPct) : ''}`}>{isOutcome ? <>{pct(r.grossRoiPct) ?? 'n/d'}<br /><small>{usd(r.grossProfit) ?? ''}</small></> : <small>No es resultado</small>}</td>
        <td className={`r ${isOutcome ? tone(r.netRoiPct) : ''}`}>{isOutcome ? <>{pct(r.netRoiPct) ?? 'Desconocido'}<br /><small>{usd(r.netProfit) ?? 'tarifa desconocida'}</small></> : <small>No es resultado</small>}</td>
        <td><button type="button" className="button ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} data-testid={`button-signal-detail-${e.tradeId}`}>{open ? 'Ocultar' : 'Evidencia'}</button></td>
      </tr>
      {open && (
        <tr id={id}><td colSpan={8} className="sg-detail">
          <EvidenceDetails r={r} />
        </td></tr>
      )}
    </Fragment>
  );
}

export function EvidenceDetails({ r }: { r: SignalOutcome }) {
  const e = r.evidence, rt = ruleText(e.rule);
  return (
    <>
          <h4>Evidencia original congelada</h4>
          <dl>
            <div><dt>Operación · ticker</dt><dd className="mono">{e.tradeId} · {e.ticker}</dd></div>
            <div><dt>Partido</dt><dd className="mono">{e.gameId} ({e.gameIdentity})</dd></div>
            <div><dt>Observada · en cola · capturada</dt><dd>{when(e.observedAt)} · {when(e.queuedAt)} · {when(e.capturedAt)}</dd></div>
            <div><dt>Precio · contratos · importe observado</dt><dd>{cents(e.price)} · {n(e.contracts)} · {preciseUsd(e.notional)}</dd></div>
            <div><dt>Mercado</dt><dd><a className="trade-link" href={e.marketUrl} target="_blank" rel="noreferrer" data-testid={`link-signal-market-${e.tradeId}`}>Kalshi <ExternalLink /></a></dd></div>
          </dl>
          <h4>Regla aplicada (versión {e.rule.version})</h4>
          <dl>
            <div><dt>Segmento</dt><dd>{e.rule.sport} · {e.rule.marketType} · lado {e.rule.side === 'yes' ? 'SÍ' : 'NO'}</dd></div>
            <div><dt>Banda de importe</dt><dd>{e.rule.moneyBand} · {rt.amount}</dd></div>
            <div><dt>Rango de precio</dt><dd>{rt.odds}</dd></div>
            <div><dt>Filtro</dt><dd>{rt.filter}</dd></div>
            <div><dt>Stake simulado</dt><dd>{usd(e.rule.stakeUsd, false)} por aviso</dd></div>
          </dl>
          <h4>ROI histórico retrospectivo (a {when(e.historyAsOf)})</h4>
          <dl>
            <div><dt>Bruto · neto est.</dt><dd>{pct(e.historicalGrossRoiPct)} · {pct(e.historicalNetRoiPct) ?? 'desconocido'}</dd></div>
            <div><dt>Muestra</dt><dd>{n(e.historicalGames)} partidos · {n(e.historicalTrades)} operaciones</dd></div>
          </dl>
          <h4>Modelo de costes congelado</h4>
          <dl>
            <div><dt>Modelo</dt><dd className="mono">{e.feeModel.version} · {e.feeModel.status}</dd></div>
            <div><dt>Tarifas consultadas · vigencia</dt><dd>{when(e.feeModel.scheduleAsOf)} · {when(e.feeModel.validUntil)}</dd></div>
            <div><dt>Tipo · multiplicador</dt><dd>{e.feeType ?? 'desconocido'} · {e.feeMultiplier ?? 'desconocido'}</dd></div>
            <div><dt>Comisión de entrada</dt><dd>{e.entryFeeUsd != null ? preciseUsd(e.entryFeeUsd) : 'Desconocida (no es cero)'}</dd></div>
            <div><dt>Supuestos</dt><dd>{e.feeAssumptions}</dd></div>
          </dl>
          <h4>Después del aviso</h4>
          <dl>
            <div><dt>Envío</dt><dd>{DELIVERY[r.delivery]} · {r.attempts} incidencias registradas{r.sentAt ? ` · ${when(r.sentAt)}` : ''}</dd></div>
            <div><dt>Resultado oficial</dt><dd>{r.officialResult ?? 'Sin resultado oficial todavía'}</dd></div>
            <div><dt>Revisión de liquidación</dt><dd>{when(r.settlementCheckedAt, 'sin revisar')}</dd></div>
          </dl>
    </>
  );
}

function Loading() {
  return (
    <div aria-label="Cargando evaluación" data-testid="loading-signals">
      <div className="sg-split">{[0, 1].map((i) => <div className="sg-block" key={i}><div className="skeleton skeleton-line" style={{ width: '40%' }} /><div className="skeleton skeleton-line" style={{ width: '70%', height: 26 }} /></div>)}</div>
      <div className="ws-card" style={{ padding: 20, marginTop: 14 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton skeleton-line" style={{ height: 30 }} />)}</div>
    </div>
  );
}
