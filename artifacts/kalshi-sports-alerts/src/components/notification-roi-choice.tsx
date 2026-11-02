import type { RoiBasis } from '@workspace/api-client-react';

export function NotificationRoiChoice({ value, saved, disabled, onChange }: {
  value: RoiBasis; saved: RoiBasis; disabled: boolean; onChange: (value: RoiBasis) => void;
}) {
  return <div className="setting-field ws-type-filter" data-testid="notification-roi-choice">
    <label className="field-label" htmlFor="notification-roi-basis">Cálculo del filtro de Telegram</label>
    <select id="notification-roi-basis" data-testid="select-notification-roi-basis"
      value={value} disabled={disabled} aria-describedby="notification-roi-help"
      onChange={event => onChange(event.target.value as RoiBasis)}>
      <option value="gross">ROI bruto ≥ +7,0% · cálculo original</option>
      <option value="net">ROI neto estimado ≥ +7,0% · después de comisión</option>
    </select>
    <p className="small-note" id="notification-roi-help">
      Guardado: <strong>{saved === 'gross' ? 'bruto, antes de comisiones' : 'neto estimado'}</strong>.
      {value !== saved ? ' Cambio pendiente: pulsa Guardar ajustes para aplicarlo.' : ' No cambia sin guardar tu elección.'}
      {' '}El neto exige una tarifa disponible para todas las muestras comparables; sin ella no envía avisos.
      Ninguno garantiza beneficio. Esta elección no cambia los colores ni elimina operaciones del historial.
    </p>
  </div>;
}
