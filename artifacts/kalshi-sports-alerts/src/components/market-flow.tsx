import { useState } from 'react';
import type { MarketFlowWindow } from '@workspace/api-client-react';
import { concentration, FLOW_WINDOWS, pickFlow, type FlowMinutes } from '@/lib/live-model';

const fmt = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

export function MarketFlow({ flow, band, scope }: { flow?: MarketFlowWindow[]; band: string; scope: string }) {
  const [minutes, setMinutes] = useState<FlowMinutes>(15);
  if (scope !== 'active') {
    return (
      <section className="ws-card ws-flow" data-testid="flow-history">
        <header><h3>Flujo por ventana</h3><p>El historial es estático: no se calcula flujo reciente para partidos antiguos o finalizados.</p></header>
      </section>
    );
  }
  const w = pickFlow(flow, minutes);
  const clusters = concentration(w, band);
  const total = w ? w.yesUsd + w.noUsd : 0;
  const yesPct = total ? (w!.yesUsd / total) * 100 : 50;
  return (
    <section className="ws-card ws-flow" data-testid="flow-summary">
      <header className="row">
        <div>
          <h3>Flujo de los últimos {minutes} min</h3>
          <p>Calculado en el servidor sobre todas las operaciones guardadas de este mercado y banda, no solo las 5,000 de los gráficos.</p>
        </div>
        <div className="ws-seg" role="group" aria-label="Ventana de flujo">
          {FLOW_WINDOWS.map((m) => (
            <button key={m} type="button" className={m === minutes ? 'on' : ''} aria-pressed={m === minutes} onClick={() => setMinutes(m)} data-testid={`filter-flow-${m}`}>{m} min</button>
          ))}
        </div>
      </header>
      {!w ? (
        <div className="ws-empty small">El servidor aún no envió el resumen de flujo.</div>
      ) : (
        <div className="ws-flow-body">
          <div className="ws-flow-bar" aria-hidden><i style={{ transform: `scaleX(${yesPct / 100})` }} /></div>
          <div className="ws-flow-grid">
            <div><span>A favor (SÍ)</span><b data-testid="text-flow-yes">{fmt(w.yesUsd)}</b><small>{w.yesCount} op.</small></div>
            <div><span>En contra (NO)</span><b data-testid="text-flow-no">{fmt(w.noUsd)}</b><small>{w.noCount} op.</small></div>
            <div><span>Balance SÍ menos NO</span><b className={w.balanceUsd >= 0 ? 'pos' : 'neg'} data-testid="text-flow-balance">{w.balanceUsd >= 0 ? '+' : '−'}{fmt(Math.abs(w.balanceUsd))}</b><small>no incluye sin dato</small></div>
            <div><span>Dirección sin dato</span><b>{fmt(w.unknownUsd)}</b><small>{w.unknownCount} op. · aparte, no se infiere</small></div>
          </div>
          {band !== 'large' ? (
            <p className="ws-sub">Sin señal de concentración en esta banda: las señales solo cuentan operaciones individuales mayores a $10,000, que no forman parte de esta banda.</p>
          ) : clusters.length === 0 ? (
            <p className="ws-sub">Sin concentración: no hay 3 o más operaciones mayores a $10,000 en la misma dirección en {minutes} min.</p>
          ) : clusters.map((c) => (
            <div key={c.dir} className={`ws-signal ${c.dir}`} data-testid={`signal-concentration-${c.dir}`}>
              <strong>Concentración {c.dir === 'yes' ? 'a favor (SÍ)' : 'en contra (NO)'}</strong>
              <span>{c.count} operaciones mayores a $10,000 · {fmt(c.usd)} en {minutes} min</span>
              <small>Señal visual, sin notificación. No implica que sea el mismo operador.</small>
            </div>
          ))}
          <p className="ws-sub">Dirección pública de cada operación; no identifica ventas, cierres ni operadores.</p>
        </div>
      )}
    </section>
  );
}
