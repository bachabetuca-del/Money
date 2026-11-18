import { Fragment, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getGetPaperAuditQueryKey, useGetPaperAudit, type PaperAuditRow } from '@workspace/api-client-react';
import { errorText } from '@/components/history-export';
import { pct, usd, when } from '@/components/signal-evaluation';

const sec = (v: number | null) => (v == null ? 'sin dato' : `${v.toLocaleString('es-US', { maximumFractionDigits: 1 })} s`);

export function PaperAudit() {
  const q = useGetPaperAudit({ query: { queryKey: getGetPaperAuditQueryKey(), refetchInterval: 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, retry: 1 } });
  const a = q.data;
  return (
    <section className="ws-card pv-audit" aria-labelledby="pv-audit-h" data-testid="section-paper-audit">
      <header className="row">
        <div><h3 id="pv-audit-h">Auditoría de avisos guardados</h3><p>Tiempos, cuentas y resultado oficial de avisos reales. Sin un libro guardado entonces, no se puede demostrar que su precio siguiera disponible.</p></div>
        {a && <div className="pv-chips"><span className="sg-tag" data-testid="text-audit-env">Entorno: {a.environment}</span><span className="sg-tag pending" data-testid="text-audit-screenshot-status">Captura: {a.screenshotStatus}</span><span className="time-text">{q.isFetching ? 'Actualizando…' : when(a.generatedAt)}</span></div>}
      </header>
      {q.isError && <div className="ws-notice error pv-pad" role="alert" data-testid="status-audit-error"><div><strong>{a ? 'No se pudo actualizar; última instantánea' : 'No se pudo cargar la auditoría'}</strong><p>{errorText(q.error, 'Error desconocido.')}</p></div><button className="button secondary" onClick={() => void q.refetch()} data-testid="button-retry-audit"><RefreshCw /> Reintentar</button></div>}
      {q.isLoading && <div className="pv-pad">{[0, 1, 2].map((i) => <div key={i} className="skeleton skeleton-line" style={{ height: 26 }} />)}</div>}
      {a && (
        <>
          {a.notes.length > 0 && <ul className="sg-limits pv-pad" data-testid="list-audit-notes">{a.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {Object.keys(a.screenshotArithmetic).length > 0 && (
            <div className="pv-pad">
              <div className="pv-label">Comprobación algebraica de porcentajes guardados · no de 379 operaciones reales</div>
              <dl className="pv-review" data-testid="list-screenshot-arithmetic">{Object.entries(a.screenshotArithmetic).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v.toLocaleString('es-US', { maximumFractionDigits: 4 })}</dd></div>)}</dl>
            </div>
          )}
          {a.rows.length === 0 ? <div className="ws-empty small" data-testid="empty-audit"><h3>Sin avisos almacenados</h3><p>No hay avisos guardados en este entorno para auditar.</p></div> : (
            <div className="ws-table-wrap" style={{ maxHeight: 'none' }}>
              <table className="ws-table pv-table" data-testid="table-paper-audit">
                <thead><tr><th>Aviso</th><th className="r">Precio · importe</th><th className="r">Retraso total</th><th className="r">ROI congelado</th><th>Resultado oficial</th><th /></tr></thead>
                <tbody>{a.rows.map((r) => <AuditRow key={r.tradeId} r={r} />)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AuditRow({ r }: { r: PaperAuditRow }) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr data-testid={`row-audit-${r.tradeId}`}>
        <td className="wrap"><b>{r.eventTitle}</b><br /><span className="time-text">{when(r.observedAt)}</span></td>
        <td className="r"><span className="sg-tag">{r.side}</span> <span className="mono">{(r.price * 100).toFixed(0)}¢</span><br /><small>{usd(r.publicAmountUsd, false)}</small></td>
        <td className="r mono">{sec(r.totalSeconds)}</td>
        <td className="r">{pct(r.frozenRoiPct) ?? 'sin dato'}</td>
        <td>{r.result ?? <small>Sin resultado oficial</small>}</td>
        <td><button className="button ghost" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`button-audit-detail-${r.tradeId}`}>{open ? 'Ocultar' : 'Detalle'}</button></td>
      </tr>
      {open && <tr><td colSpan={6} className="sg-detail"><dl>
        <div><dt>Mercado a cola · cola a decisión · decisión a confirmación</dt><dd>{sec(r.exchangeToQueueSeconds)} · {sec(r.queueToDecisionSeconds)} · {sec(r.decisionToConfirmSeconds)}</dd></div>
        <div><dt>En cola · capturado · confirmado</dt><dd>{when(r.queuedAt)} · {when(r.capturedAt)} · {when(r.confirmedAt)}</dd></div>
        <div><dt>Intentos de envío</dt><dd>{r.attempts}</dd></div>
        <div><dt>Muestra histórica</dt><dd>{r.historicalGames ?? 'sin dato'} partidos · {r.historicalTrades ?? 'sin dato'} operaciones</dd></div>
        <div><dt>Comisión de entrada</dt><dd>{r.entryFeeUsd != null ? usd(r.entryFeeUsd, false) : 'Desconocida (no es cero)'}</dd></div>
        <div><dt>Resultado bruto hipotético</dt><dd>{usd(r.hypotheticalGrossProfitUsd) ?? 'Evidencia insuficiente'}</dd></div>
        {r.notes.length > 0 && <div><dt>Notas</dt><dd>{r.notes.join(' · ')}</dd></div>}
      </dl></td></tr>}
    </Fragment>
  );
}
