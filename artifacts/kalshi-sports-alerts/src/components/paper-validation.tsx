import { Fragment, useState } from 'react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, EyeOff, FlaskConical, LoaderCircle, Pause, Play, Plus, RefreshCw } from 'lucide-react';
import {
  exportPaperRun, getGetPaperDashboardQueryKey, useChangePaperRunState, useGetPaperDashboard,
  type GetPaperDashboardParams, type PaperComparison, type PaperDashboard, type PaperExecution,
  type PaperInterval, type PaperOpportunity, type PaperRun, type PaperStats,
} from '@workspace/api-client-react';
import { errorText, saveBlob } from '@/components/history-export';
import { setUrlParams } from '@/lib/navigation';
import { pct, usd, when } from '@/components/signal-evaluation';
import { PaperProtocolForm, protocolLines } from '@/components/paper-protocol-form';
import { PaperAudit } from '@/components/paper-audit';
import './paper-validation.css';

const RUN: Record<PaperRun['status'], string> = { draft: 'Borrador', active: 'En curso', paused: 'Detenida', finished: 'Terminada' };
const EXEC: Record<PaperExecution['status'], string> = { pending: 'Pendiente', full: 'Completa', partial: 'Parcial', none: 'Sin ejecución', unknown: 'Desconocida' };
const PHASE: Record<string, string> = { calibration: 'Calibración', holdout: 'Tramo oculto' };
const SECRET = /chat|secret|token|password|key/i;
const tone = (v: number | null | undefined) => (v == null ? 'unk' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const n = (v: number) => v.toLocaleString('es-US');
const ci = (i?: PaperInterval) => (i ? `IC 95%: ${pct(i.lower)} a ${pct(i.upper)} · ${n(i.clusters)} partidos` : 'Sin intervalo: evidencia insuficiente');

function readUrl(): GetPaperDashboardParams {
  const p = new URLSearchParams(window.location.search);
  const page = Number(p.get('paperPage'));
  return { runId: p.get('paperRun') || undefined, page: Number.isInteger(page) && page > 1 ? page : undefined };
}

export function PaperValidation() {
  const qc = useQueryClient();
  const [params, setParams] = useState<GetPaperDashboardParams>(readUrl);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<'start' | 'pause' | null>(null);
  const q = useGetPaperDashboard(params, { query: {
    queryKey: getGetPaperDashboardQueryKey(params), refetchInterval: 30_000, refetchIntervalInBackground: false,
    refetchOnWindowFocus: true, retry: 1, placeholderData: keepPreviousData,
  } });
  const change = useChangePaperRunState();
  const d = q.data;
  const stale = q.isPlaceholderData;

  function go(next: GetPaperDashboardParams) {
    setParams(next);
    setUrlParams({ paperRun: next.runId ?? null, paperPage: next.page && next.page > 1 ? String(next.page) : null });
  }
  function act(id: string, action: 'start' | 'pause') {
    change.mutate({ id, data: { action } }, { onSettled: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['/api/kalshi/paper'] });
      void qc.invalidateQueries({ queryKey: ['/api/kalshi/paper/audit'] });
    } });
  }

  const run = d?.runs.find((r) => r.id === d.selectedRunId) ?? null;

  return (
    <section className="pv" data-testid="paper-validation" aria-labelledby="pv-title">
      <div className="pv-head">
        <div>
          <div className="eyebrow">Validación sin dinero · libro de órdenes real</div>
          <h2 id="pv-title"><FlaskConical size={20} /> ¿Se podía seguir de verdad?</h2>
          <p>Un ROI histórico atractivo no basta. Esta prueba simula, sin dinero, comprar cada aviso con retraso y contra el libro de órdenes que había en ese momento. Los resultados se fijan antes de verlos.</p>
        </div>
        <div className="sg-snap" data-testid="text-paper-snapshot">
          <span>{q.isFetching ? 'Actualizando…' : d ? `Instantánea ${when(d.generatedAt)}` : 'Sin instantánea'}</span>
          <span>Se actualiza cada 30 s</span>
          {stale && <span className="sg-tag pending" data-testid="status-paper-stale">Cargando…</span>}
        </div>
      </div>

      <div className="pv-concepts" data-testid="list-paper-concepts">
        <div><b>1 · Retrospectivo</b><p>ROI histórico que justificó el aviso. Describe el pasado, no lo que se podía comprar.</p></div>
        <div><b>2 · Precio público</b><p>Evaluación anterior de esta pestaña: $100 al precio observado del aviso, sin libro.</p></div>
        <div className="on"><b>3 · Libro de órdenes</b><p>Esta prueba: compra con retraso, límite de precio, capital y comisiones contra el libro real.</p></div>
      </div>

      {q.isError && <div className="ws-notice error" role="alert" data-testid="status-paper-error"><div><strong>{d ? 'No se pudo actualizar; se muestra la última instantánea' : 'No se pudo cargar la prueba'}</strong><p>{errorText(q.error, 'Error desconocido.')}</p></div><button className="button secondary" onClick={() => void q.refetch()} data-testid="button-retry-paper"><RefreshCw /> Reintentar</button></div>}
      {q.isLoading && <div className="pv-card">{[0, 1, 2].map((i) => <div key={i} className="skeleton skeleton-line" style={{ height: 28 }} />)}</div>}

      {d && (
        <>
          {!d.activationAllowed && <div className="ws-notice warn" role="note" data-testid="notice-paper-activation"><div><strong>Este entorno no puede iniciar pruebas</strong><p>Puedes guardar borradores aquí, pero para registrar avisos hay que publicar la aplicación e iniciar la prueba desde la versión publicada. Nada se está registrando en este entorno. Un borrador guardado aquí no pasa a la versión publicada: allí tendrás que crear y revisar de nuevo el protocolo.</p></div></div>}

          <div className="pv-card">
            <div className="pv-runbar">
              <label className="ws-type-filter">Prueba
                <select value={d.selectedRunId ?? ''} disabled={stale || d.runs.length === 0} onChange={(e) => go({ runId: e.target.value || undefined })} data-testid="select-paper-run">
                  {d.runs.length === 0 && <option value="">Sin pruebas</option>}
                  {d.runs.map((r) => <option key={r.id} value={r.id}>{r.protocol.name} · {RUN[r.status]} · {when(r.createdAt)}</option>)}
                </select>
              </label>
              {!creating && <button className="button secondary" onClick={() => setCreating(true)} data-testid="button-paper-new"><Plus /> Nuevo borrador</button>}
            </div>
            {creating && <PaperProtocolForm onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); go({ runId: r.id }); }} />}
            {!run && !creating && <div className="ws-empty small" data-testid="empty-paper-runs"><h3>Sin prueba seleccionada</h3><p>Crea un borrador, revísalo y guárdalo. Iniciar es un paso aparte que solo funciona en la versión publicada.</p></div>}
            {run && <RunPanel run={run} d={d} confirm={confirm} setConfirm={setConfirm} pending={change.isPending} onAct={act} error={change.isError ? errorText(change.error, 'Error desconocido.') : null} />}
          </div>

          {run && run.status !== 'draft' && (
            <>
              {d.holdoutHidden && <div className="ws-notice" role="status" data-testid="notice-holdout-hidden"><div><strong><EyeOff size={13} /> Tramo final oculto hasta {when(run.endsAt, 'el cierre fijado')}</strong><p>Los resultados de los últimos días se muestran solo como recuentos hasta la fecha de cierre, aunque la prueba esté detenida. Así no se puede ajustar la regla mirando el final.</p></div></div>}
              <StatsBlock stats={d.stats} />
              <Comparisons list={d.comparisons} />
              <Rows d={d} run={run} stale={stale} go={(p) => go({ runId: run.id, page: p })} />
            </>
          )}
          {d.limitations.length > 0 && <div className="pv-card"><h3 className="pv-h3">Limitaciones</h3><ul className="sg-limits" data-testid="list-paper-limitations">{d.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></div>}
        </>
      )}
      <PaperAudit />
    </section>
  );
}

function RunPanel({ run, d, confirm, setConfirm, pending, onAct, error }: { run: PaperRun; d: PaperDashboard; confirm: 'start' | 'pause' | null; setConfirm: (v: 'start' | 'pause' | null) => void; pending: boolean; onAct: (id: string, a: 'start' | 'pause') => void; error: string | null }) {
  const p = run.protocol;
  const [dl, setDl] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState('');
  async function download(format: 'json' | 'csv') {
    setDl(format); setDlErr('');
    try { saveBlob(await exportPaperRun({ id: run.id, format }, { responseType: 'blob' }), `fieldnote-prueba-${run.id}.${format}`); }
    catch (e) { setDlErr(errorText(e, 'No se pudo descargar.')); }
    finally { setDl(null); }
  }
  return (
    <div className="pv-run" data-testid={`panel-paper-run-${run.id}`}>
      <div className="pv-run-top">
        <div><span className={`pv-status ${run.status}`} data-testid="status-paper-run"><i />{RUN[run.status]}</span><h3>{p.name}</h3>
          <p className="time-text">Creada {when(run.createdAt)}{run.activatedAt && ` · inicio ${when(run.activatedAt)}`}{run.holdoutAt && ` · tramo oculto desde ${when(run.holdoutAt)}`}{run.endsAt && ` · cierre ${when(run.endsAt)}`}{run.pausedAt && ` · detenida ${when(run.pausedAt)}`}</p></div>
        <div className="pv-actions">
          {run.status === 'draft' && <button className="button" disabled={!d.activationAllowed || pending} title={d.activationAllowed ? undefined : 'Solo en la versión publicada'} onClick={() => setConfirm('start')} data-testid="button-paper-start"><Play /> Iniciar</button>}
          {run.status === 'active' && <button className="button secondary" disabled={pending} onClick={() => setConfirm('pause')} data-testid="button-paper-pause"><Pause /> Detener</button>}
          {run.status !== 'draft' && <><button className="button ghost" disabled={!!dl} onClick={() => void download('csv')} data-testid="button-paper-csv">{dl === 'csv' ? <LoaderCircle className="spin" /> : <Download />} CSV</button>
            <button className="button ghost" disabled={!!dl} onClick={() => void download('json')} data-testid="button-paper-json">{dl === 'json' ? <LoaderCircle className="spin" /> : <Download />} JSON</button></>}
        </div>
      </div>
      {run.status === 'draft' && !d.activationAllowed && <p className="pv-note" data-testid="text-paper-draft-blocked">Borrador guardado. No está activo: publica la aplicación e inícialo desde allí.</p>}
      {run.status === 'paused' && <p className="pv-note" data-testid="text-paper-paused">Una prueba detenida no se reanuda. Para una nueva cohorte, crea otro borrador.</p>}
      {run.workerError && <div className="ws-notice error" role="alert"><div><strong>Incidencia del registro</strong><p>{run.workerError}</p></div></div>}
      {run.status === 'active' && <p className="pv-note">Último latido {when(run.heartbeatAt, 'sin latido todavía')} · {n(run.dropped)} avisos descartados por límites · {n(d.recorded)} registrados</p>}
      {confirm && (
        <div className="pv-confirm" role="alertdialog" aria-label="Confirmar" data-testid="dialog-paper-confirm">
          <p>{confirm === 'start' ? `Iniciar fija la fecha de cierre (${p.runDays} días) y el tramo oculto final. El protocolo no se podrá cambiar.` : 'Detener es definitivo: la prueba no se puede reanudar. El tramo oculto sigue oculto hasta la fecha de cierre.'}</p>
          <div className="pv-actions"><button className="button secondary" disabled={pending} onClick={() => setConfirm(null)} data-testid="button-paper-cancel">Cancelar</button>
            <button className="button" disabled={pending} onClick={() => onAct(run.id, confirm)} data-testid="button-paper-confirm">{pending ? <LoaderCircle className="spin" /> : confirm === 'start' ? <Play /> : <Pause />}{confirm === 'start' ? 'Sí, iniciar' : 'Sí, detener'}</button></div>
        </div>
      )}
      {error && <div className="ws-notice error" role="alert" data-testid="status-paper-state-error"><div><strong>No se cambió el estado</strong><p>{error}</p></div></div>}
      {dlErr && <p className="pv-note neg" role="alert">{dlErr}</p>}
      <details className="pv-proto"><summary>Protocolo congelado · versión {p.version}</summary>
        <dl className="pv-review">{protocolLines(p).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div><dt>Regla heredada</dt><dd>{p.ruleVersion} · ROI {p.basis === 'net' ? 'neto est.' : 'bruto'} ≥ {pct(p.minimumRoiPct)} · ≥ {p.minimumGames} partidos · ≥ {p.minimumTrades} op.</dd></div></dl>
        {p.assumptions.length > 0 && <ul className="sg-limits">{p.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>}
      </details>
    </div>
  );
}

function StatsBlock({ stats }: { stats: PaperStats[] }) {
  if (stats.length === 0) return <div className="pv-card ws-empty small" data-testid="empty-paper-stats"><h3>Evidencia insuficiente</h3><p>Todavía no hay oportunidades registradas. Eso no es un ROI de 0%.</p></div>;
  return (
    <div className="pv-card"><h3 className="pv-h3">Escenarios simulados</h3>
      <p className="pv-sub">Cada fila combina grupo, fase, política de repetición y retraso. «Desconocida» significa que no hubo libro fiable: no se cuenta como pérdida, solo se muestra cómo cambiaría el ROI en los extremos.</p>
      <div className="pv-stats">
        {stats.map((s) => {
          const k = `${s.cohort}-${s.phase}-${s.policy}-${s.delaySeconds}`;
          return (
            <article key={k} className="pv-stat" data-testid={`card-paper-stats-${k}`}>
              <div className="pv-stat-tags"><span className="sg-tag">{s.cohort === 'alerts' ? 'Avisos' : 'Control'}</span><span className="sg-tag">{PHASE[s.phase] ?? s.phase}</span><span className="sg-tag">{s.policy === 'first' ? 'Primero' : 'Todos'}</span><span className="sg-tag">{s.delaySeconds} s</span></div>
              <b className={`pv-roi ${tone(s.netRoiPct)}`}>{pct(s.netRoiPct) ?? 'Evidencia insuficiente'}</b>
              <small>{s.netRoiPct != null ? `ROI neto · ${usd(s.netProfitUsd)} · ${ci(s.interval)}` : `${n(s.settled)} liquidadas`}</small>
              <dl>
                <div><dt>Oportunidades</dt><dd>{n(s.opportunities)}</dd></div>
                <div><dt>Completa · parcial · nada</dt><dd>{n(s.full)} · {n(s.partial)} · {n(s.none)}</dd></div>
                <div><dt>Desconocidas · pendientes</dt><dd>{n(s.unknown)} · {n(s.pending)}</dd></div>
                <div><dt>Cobertura</dt><dd>{pct(s.coveragePct)?.replace('+', '')}</dd></div>
                <div><dt>Partidos (aprox.)</dt><dd>{n(s.games)} ({n(s.approximateGames)})</dd></div>
                <div><dt>Invertido · comisiones</dt><dd>{usd(s.deployedUsd, false)} · {usd(s.feesUsd, false)}</dd></div>
                <div><dt>Comprometido · libre</dt><dd>{usd(s.committedUsd, false)} · {usd(s.freeCapitalUsd, false)}</dd></div>
                <div><dt>Por aviso</dt><dd>{usd(s.profitPerAlertUsd) ?? 'sin dato'}</dd></div>
                <div><dt>Sin el mejor partido</dt><dd>{pct(s.withoutBestGameRoiPct) ?? 'sin dato'}</dd></div>
                <div><dt>Desconocidas si pierden · si ganan</dt><dd>{pct(s.unknownLossScenarioRoiPct) ?? 'n/d'} · {pct(s.unknownWinScenarioRoiPct) ?? 'n/d'}</dd></div>
                {s.dateInterval && <div><dt>Por fechas</dt><dd>{ci(s.dateInterval)}</dd></div>}
              </dl>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Comparisons({ list }: { list: PaperComparison[] }) {
  if (list.length === 0) return null;
  return (
    <div className="pv-card"><h3 className="pv-h3">Avisos frente a control</h3>
      <p className="pv-sub">Diferencia de ROI neto entre avisos y operaciones de control emparejadas. Intervalos al 95% agrupando por partido. Un ROI hipotético positivo no prueba rentabilidad, y 50 partidos no bastan para validar una regla. Ningún resultado garantiza beneficios futuros.</p>
      {list.map((c) => (
        <div key={c.phase} className="pv-cmp" data-testid={`card-paper-comparison-${c.phase}`}>
          <div><span className="sg-tag">{PHASE[c.phase] ?? c.phase}</span> <b className={tone(c.deltaNetRoiPct)}>{c.deltaNetRoiPct != null ? `${pct(c.deltaNetRoiPct)} de diferencia` : 'Evidencia insuficiente'}</b></div>
          <small>{n(c.pairs)} pares · cobertura {pct(c.coveragePct)?.replace('+', '')} · {ci(c.interval)}</small>
          <p>{c.conclusion}</p>
          {c.residuals.length > 0 && <ul className="sg-limits">{c.residuals.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </div>
      ))}
    </div>
  );
}

function Rows({ d, run, stale, go }: { d: PaperDashboard; run: PaperRun; stale: boolean; go: (p: number) => void }) {
  return (
    <div className={`ws-card ${stale ? 'stale' : ''}`} aria-busy={stale}>
      <header><h3>Oportunidades registradas</h3><p>{n(d.recorded)} en total. Abre una fila para ver cada ejecución simulada y la evidencia guardada.</p></header>
      {d.rows.length === 0 ? <div className="ws-empty small" data-testid="empty-paper-rows"><h3>{run.status === 'active' ? 'Esperando el primer aviso' : 'Sin oportunidades'}</h3><p>Sin filas no hay resultado: evidencia insuficiente. Las ejecuciones nulas o desconocidas nunca cuentan como pérdidas.</p></div> : (
        <>
          <div className="ws-table-wrap" style={{ maxHeight: 'none' }}>
            <table className="ws-table pv-table" data-testid="table-paper-rows">
              <thead><tr><th>Aviso</th><th className="r">Precio observado · ROI hist.</th><th>Fase</th><th>Ejecuciones</th><th /></tr></thead>
              <tbody>{d.rows.map((r) => <OppRow key={r.id} r={r} />)}</tbody>
            </table>
          </div>
          <nav className="pv-pager" aria-label="Paginación de oportunidades">
            <button className="button secondary" disabled={d.page <= 1 || stale} onClick={() => go(d.page - 1)} data-testid="button-paper-prev"><ChevronLeft /> Anterior</button>
            <span className="mono" data-testid="text-paper-page">Página {d.page} de {Math.max(1, d.totalPages)}</span>
            <button className="button secondary" disabled={d.page >= d.totalPages || stale} onClick={() => go(d.page + 1)} data-testid="button-paper-next">Siguiente <ChevronRight /></button>
          </nav>
        </>
      )}
    </div>
  );
}

function safeEvidence(e: Record<string, unknown>) {
  return Object.entries(e).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const);
}

function OppRow({ r }: { r: PaperOpportunity }) {
  const [open, setOpen] = useState(false);
  const counts = r.executions.reduce<Record<string, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {});
  return (
    <Fragment>
      <tr data-testid={`row-paper-${r.id}`}>
        <td className="wrap"><b>{r.eventTitle}</b><br /><small>{r.marketTitle}</small><br /><span className="time-text">{when(r.observedAt)}</span></td>
        <td className="r"><span className="sg-tag">{r.side}</span> <span className="mono" title="Precio observado en el aviso">{(r.price * 100).toFixed(0)}¢ obs.</span><br /><small>{pct(r.historicalRoiPct) ?? 'sin dato'} · {n(r.historicalGames)} part.</small></td>
        <td><span className="sg-tag">{PHASE[r.phase] ?? r.phase}</span>{!r.eligible && <><br /><small>No elegible: {r.reason}</small></>}</td>
        <td>{Object.entries(counts).map(([k, v]) => <span key={k} className={`sg-tag pv-ex ${k}`}>{EXEC[k as PaperExecution['status']] ?? k} {v}</span>)}{r.executions.length === 0 && <small>Ninguna</small>}</td>
        <td><button className="button ghost" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`button-paper-detail-${r.id}`}>{open ? 'Ocultar' : 'Detalle'}</button></td>
      </tr>
      {open && <tr><td colSpan={5} className="sg-detail">
        <h4>Ejecuciones simuladas</h4>
        <div className="pv-execs">{r.executions.map((x, i) => (
          <div key={i} className="pv-exec" data-testid={`card-paper-exec-${r.id}-${i}`}>
            <div><span className={`sg-tag pv-ex ${x.status}`}>{EXEC[x.status]}</span> <span className="mono">{x.delaySeconds} s · {x.policy === 'first' ? 'primero' : 'todos'}</span></div>
            <small>{x.reason}</small>
            <dl>
              <div><dt>Previsto · capturado</dt><dd>{when(x.dueAt)} · {when(x.capturedAt)}</dd></div>
              <div><dt>Contratos · coste · comisión</dt><dd>{n(x.contracts)} · {usd(x.costUsd, false)} · {x.feeUsd != null ? usd(x.feeUsd, false) : 'desconocida'}</dd></div>
              <div><dt>Precio simulado medio · mejor oferta disponible</dt><dd>{x.averagePrice != null ? `${(x.averagePrice * 100).toFixed(1)}¢` : 'n/d'} · {x.bestAsk != null ? `${(x.bestAsk * 100).toFixed(1)}¢` : 'n/d'}</dd></div>
              <div><dt>Liquidación · neto</dt><dd>{x.settlement} · {usd(x.netProfitUsd) ?? 'sin resultado'}</dd></div>
            </dl>
          </div>
        ))}</div>
        <h4>Evidencia guardada</h4>
        <dl>
          <div><dt>Operación · ticker · partido</dt><dd className="mono">{r.tradeId} · {r.ticker} · {r.gameId} ({r.gameIdentity})</dd></div>
          <div><dt>En cola · decidido · confirmado</dt><dd>{when(r.queuedAt)} · {when(r.decidedAt)} · {when(r.confirmedAt)}</dd></div>
          {safeEvidence(r.evidence).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}
        </dl>
      </td></tr>}
    </Fragment>
  );
}
