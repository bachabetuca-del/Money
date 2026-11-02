import type { RoiFeeModel, RoiNetEstimate } from '@workspace/api-client-react';

const pct = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('es-US', { maximumFractionDigits: 2 })}%`;
const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

export function RoiNetValue({ net }: { net: RoiNetEstimate }) {
  const complete = net.roiPct !== null;
  return <span className={`roi-net-value ${complete ? net.roiPct! > 0 ? 'pos' : net.roiPct! < 0 ? 'neg' : '' : ''}`}
    title={complete ? `Comisiones estimadas: ${usd(net.fees!)}. Desembolso con comisiones: ${usd(net.cashOutlay!)}.`
      : 'Faltan tarifas vigentes o hay reglas no compatibles. No se comparan muestras diferentes ni se supone coste cero.'}>
    {complete ? pct(net.roiPct!) : 'No disponible'}
    <small className="lb-cell-sub">{net.coveredTrades.toLocaleString('es-US')}/{(net.coveredTrades + net.missingTrades).toLocaleString('es-US')} con tarifa{net.missingTrades > 0 ? ` · faltan ${net.missingTrades.toLocaleString('es-US')}` : ''}</small>
  </span>;
}

/** Shared, explicit assumptions on both the ranking and selected signal. */
export function RoiFeeMethodology({ model }: { model?: RoiFeeModel }) {
  return <div className="roi-cost-method" data-testid="roi-fee-methodology">
    <p role="note">
      <strong>Bruto ≠ neto.</strong> El neto estimado resta la comisión de entrada y la incluye en el desembolso.
      {' '}{model?.status === 'current'
        ? `Tarifas públicas consultadas el ${new Date(model.scheduleAsOf!).toLocaleString('es-US', { timeZone: 'America/New_York' })} ET.`
        : model?.status === 'stale' ? 'Tarifas caducadas: el neto queda no disponible hasta la siguiente consulta completa.'
        : 'Sin tarifas verificadas disponibles: se mantiene el bruto y no se inventa el neto.'}
    </p>
    <details>
      <summary>Suposiciones, comisiones y costes no incluidos</summary>
      <ul>
        <li>Mismas operaciones y $100 hipotéticos de entrada para bruto y neto. Cantidad teórica C = 100 / precio del lado SÍ o NO; no se redondea a contratos negociables. No es una orden ejecutable.</li>
        <li>Una compra inmediata que toma liquidez (taker) por observación, al precio guardado, mantenida hasta liquidación binaria oficial. Comisión = 0,07 × multiplicador × C × P × (1 − P). Se cobra también en operaciones perdedoras.</li>
        <li>Tarifas <strong>actuales aplicadas al histórico</strong>, con multiplicadores de serie y excepciones de evento. No reconstruye las tarifas pagadas en la fecha de cada operación. Tarifas desconocidas, tipos no compatibles o datos de más de 24 h dejan el neto sin estimar; no eliminan muestras del bruto.</li>
        <li>Cuenta directa: comisión redondeada hacia arriba a $0,000001 y desembolso a $0,0001 por entrada. Como la entrada es de $100 exactos, equivale a redondear la comisión a $0,0001. No se simulan órdenes divididas ni devoluciones de redondeo.</li>
        <li>ROI bruto = resultado bruto / suma de entradas × 100. ROI neto = (resultado bruto − comisiones) / (suma de entradas + comisiones) × 100. Las comisiones son adicionales a los $100, no se descuenta cantidad de contratos.</li>
        <li>No hay comisión de liquidación. No se modelan venta anticipada, deslizamiento, diferencial adicional, depósitos/retiros, impuestos ni cargos de intermediarios (FCM). Las órdenes maker pueden pagar una tarifa distinta; no se supone ejecución gratuita.</li>
      </ul>
      <p>Ambos son simulaciones, no el beneficio de un trader ni garantía de ganancias. La actividad pública no revela su cartera, intención de compra/cierre o condiciones reales de ejecución.</p>
      {model && <p>Documentación revisada: {model.documentationReviewedOn}. Fuentes oficiales:
        {' '}<a href={model.sources[0]} target="_blank" rel="noreferrer">tarifario</a>
        {' · '}<a href={model.sources[1]} target="_blank" rel="noreferrer">excepciones</a>
        {' · '}<a href={model.sources[2]} target="_blank" rel="noreferrer">redondeo</a>
        {' · '}<a href={model.sources[3]} target="_blank" rel="noreferrer">series</a>
        {' · '}<a href={model.sources[4]} target="_blank" rel="noreferrer">eventos</a>
      </p>}
    </details>
  </div>;
}
