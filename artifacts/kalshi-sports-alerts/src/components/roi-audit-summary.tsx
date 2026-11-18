import type { RoiAudit, RoiLeaderboard } from '@workspace/api-client-react';

const pct = (n: number | null) => n === null ? 'Sin evidencia suficiente' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
export function RoiAuditSummary({ audit }: { audit?: RoiAudit }) {
  if (!audit) return null;
  return <section aria-label="Comprobaciones del ROI" className="lb-methodology-body" data-testid="roi-audit-summary">
    <h4>Qué respalda este resultado</h4>
    <p>Entradas del {new Date(audit.firstAt).toLocaleDateString()} al {new Date(audit.lastAt).toLocaleDateString()}.
      {' '}El partido con más entradas representa el {audit.largestGameSharePct.toFixed(1)}% de la muestra.
      {' '}ROI bruto sin el partido que más ganó: <b>{pct(audit.withoutBestGameRoiPct)}</b>.</p>
    <p>Intervalo descriptivo 95% del ROI bruto, agrupado por partido: <b>
      {audit.grossLower95Pct === null || audit.grossUpper95Pct === null ? 'Se requieren al menos 10 partidos' :
        `${pct(audit.grossLower95Pct)} a ${pct(audit.grossUpper95Pct)}`}</b>.
      {' '}Aproximación normal; no corrige por buscar muchas estrategias y no certifica rentabilidad.</p>
    <p>Primer tramo: {audit.earlierGames} partidos · {pct(audit.earlierRoiPct)} bruto.
      {' '}Tramo posterior: {audit.laterGames} partidos · {pct(audit.laterRoiPct)} bruto.
      {' '}Ningún partido aparece en ambos tramos. Es una comparación retrospectiva 70/30,
      no una validación independiente ni una prueba futura.</p>
  </section>;
}

export function RoiMethodSummary({ data }: { data: RoiLeaderboard }) {
  const m = data.methodology;
  if (!m) return null;
  return <section className="ws-notice" data-testid="roi-method-summary">
    <div>
      <strong>{m.unit === 'game' ? 'Principal: primera entrada por patrón y partido' : 'Secundario: cada ejecución pública'}</strong>
      <p>{m.description}</p>
      <p>{m.rawExecutions.toLocaleString()} ejecuciones en la ventana; {m.selectedEntries.toLocaleString()} entradas en esta vista.
        {m.unit === 'game' && ` ${m.repeatedExecutions.toLocaleString()} repeticiones omitidas, no borradas.`}
        {' '}Sin fase confirmable: {m.unknownPhaseExecutions.toLocaleString()}.
        {' '}Sin identidad inequívoca: {m.ambiguousIdentityExecutions.toLocaleString()}.
        {' '}Sin tipo compatible: {m.unclassifiedExecutions.toLocaleString()}.
        {' '}Estos recuentos pueden solaparse.</p>
      <p>Prepartido y cercanía usan el horario guardado de Kalshi, no prueban el inicio real.
        “En vivo” exige evidencia del proveedor en los 120 s anteriores a la operación.
        Si falta, queda en fase desconocida. Una revisión posterior del horario puede cambiar la clasificación histórica.</p>
      <p>Versión {m.version}. La regla se selecciona con resultados conocidos: no hay corrección por comparaciones múltiples
        ni una ventaja futura demostrada. Revisa por separado <a href="?tab=signals">Señales y prueba sin dinero</a>.</p>
    </div>
  </section>;
}
