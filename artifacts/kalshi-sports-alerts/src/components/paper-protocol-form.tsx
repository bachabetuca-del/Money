import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, LoaderCircle, Lock, Plus, X } from 'lucide-react';
import { useCreatePaperRun, type PaperProtocolInput, type PaperRun } from '@workspace/api-client-react';
import { errorText } from '@/components/history-export';

type Form = Omit<PaperProtocolInput, 'requestId'>;
export const PAPER_DEFAULTS: Form = {
  name: 'Prueba sin dinero', stakeUsd: 100, capitalUsd: 10000, maxGameUsd: 110, delaySeconds: 30,
  limitCents: 1, runDays: 28, holdoutDays: 7, repetitions: 'first', maxMarkets: 8,
};
type NumKey = Exclude<keyof Form, 'name' | 'repetitions'>;
const FIELDS: { k: NumKey; l: string; h: string; min: number; max: number; unit: string }[] = [
  { k: 'stakeUsd', l: 'Importe por aviso', h: 'Lo que se intentaría comprar en cada aviso', min: 1, max: 10000, unit: 'USD' },
  { k: 'capitalUsd', l: 'Capital simulado total', h: 'Límite de dinero comprometido a la vez', min: 100, max: 1000000, unit: 'USD' },
  { k: 'maxGameUsd', l: 'Máximo por partido', h: 'Tope de exposición en un mismo partido', min: 1, max: 100000, unit: 'USD' },
  { k: 'delaySeconds', l: 'Retraso de reacción', h: 'Segundos entre el aviso y la compra simulada', min: 0, max: 300, unit: 's' },
  { k: 'limitCents', l: 'Margen sobre el precio', h: 'Centavos máximos por encima del precio del aviso', min: 0, max: 10, unit: '¢' },
  { k: 'runDays', l: 'Duración total', h: 'Días desde el inicio hasta el cierre fijo', min: 2, max: 90, unit: 'días' },
  { k: 'holdoutDays', l: 'Tramo final oculto', h: 'Últimos días cuyos resultados no se ven hasta el cierre', min: 1, max: 89, unit: 'días' },
  { k: 'maxMarkets', l: 'Mercados por partido', h: 'Máximo de mercados distintos en un partido', min: 1, max: 20, unit: '' },
];

export function validatePaper(f: Form): string[] {
  const e: string[] = [];
  const name = f.name.trim();
  if (!name || name.length > 80) e.push('El nombre debe tener entre 1 y 80 caracteres.');
  for (const x of FIELDS) {
    const v = f[x.k];
    if (!Number.isFinite(v) || v < x.min || v > x.max) e.push(`${x.l}: entre ${x.min} y ${x.max}.`);
  }
  if (f.holdoutDays >= f.runDays) e.push('El tramo final oculto debe ser más corto que la duración total.');
  if (!(f.capitalUsd >= f.maxGameUsd && f.maxGameUsd >= f.stakeUsd)) e.push('Debe cumplirse: capital total ≥ máximo por partido ≥ importe por aviso.');
  return e;
}

export function protocolLines(f: Form): [string, string][] {
  return [
    ['Nombre', f.name.trim()],
    ['Importe por aviso', `$${f.stakeUsd.toLocaleString('en-US')}`],
    ['Capital simulado', `$${f.capitalUsd.toLocaleString('en-US')}`],
    ['Máximo por partido', `$${f.maxGameUsd.toLocaleString('en-US')}`],
    ['Retraso de reacción', `${f.delaySeconds} s`],
    ['Margen sobre el precio', `${f.limitCents}¢`],
    ['Duración · tramo oculto', `${f.runDays} días · últimos ${f.holdoutDays} ocultos`],
    ['Repeticiones en un mercado', f.repetitions === 'first' ? 'Solo el primer aviso' : 'Todos los avisos'],
    ['Mercados por partido', String(f.maxMarkets)],
  ];
}

export function PaperProtocolForm({ onCreated, onClose }: { onCreated: (r: PaperRun) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(PAPER_DEFAULTS);
  const [raw, setRaw] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((x) => [x.k, String(PAPER_DEFAULTS[x.k])])));
  const [review, setReview] = useState(false);
  const reqId = useRef<string | null>(null);
  const create = useCreatePaperRun();
  const errs = validatePaper(f);

  function setNum(k: NumKey, v: string) {
    setRaw((r) => ({ ...r, [k]: v }));
    setF((p) => ({ ...p, [k]: v.trim() === '' ? NaN : Number(v) }));
    reqId.current = null;
  }
  function toReview() {
    if (errs.length) return;
    if (!reqId.current) reqId.current = crypto.randomUUID();
    setReview(true);
  }
  function save() {
    if (errs.length || create.isPending || !reqId.current) return;
    create.mutate({ data: { ...f, name: f.name.trim(), requestId: reqId.current } }, {
      onSuccess: (run) => {
        reqId.current = null;
        void qc.invalidateQueries({ queryKey: ['/api/kalshi/paper'] });
        void qc.invalidateQueries({ queryKey: ['/api/kalshi/paper/audit'] });
        onCreated(run);
      },
    });
  }

  return (
    <section className="pv-form" aria-labelledby="pv-form-title" data-testid="form-paper-protocol">
      <header>
        <div><h4 id="pv-form-title">{review ? 'Revisa el protocolo antes de guardarlo' : 'Nuevo protocolo de prueba'}</h4>
          <p>{review ? 'Una vez guardado no se puede editar. Para cambiar algo crearás otro borrador.' : 'Se guarda como borrador inmutable. Iniciar es un paso aparte.'}</p></div>
        <button type="button" className="button ghost" onClick={onClose} aria-label="Cerrar" data-testid="button-paper-form-close"><X /></button>
      </header>
      {!review ? (
        <>
          <label className="pv-field wide"><span>Nombre</span>
            <input value={f.name} maxLength={80} onChange={(e) => { setF({ ...f, name: e.target.value }); reqId.current = null; }} data-testid="input-paper-name" /></label>
          <div className="pv-grid">
            {FIELDS.map((x) => (
              <label key={x.k} className="pv-field"><span>{x.l}{x.unit && <em>{x.unit}</em>}</span>
                <input type="number" inputMode="decimal" min={x.min} max={x.max} value={raw[x.k]} onChange={(e) => setNum(x.k, e.target.value)} data-testid={`input-paper-${x.k}`} />
                <small>{x.h}</small></label>
            ))}
            <fieldset className="pv-field"><span>Repeticiones en un mercado</span>
              <div className="ws-seg">
                <button type="button" className={f.repetitions === 'first' ? 'on' : ''} onClick={() => { setF({ ...f, repetitions: 'first' }); reqId.current = null; }} data-testid="button-paper-rep-first">Solo el primero</button>
                <button type="button" className={f.repetitions === 'all' ? 'on' : ''} onClick={() => { setF({ ...f, repetitions: 'all' }); reqId.current = null; }} data-testid="button-paper-rep-all">Todos</button>
              </div><small>Si el mismo mercado avisa varias veces</small></fieldset>
          </div>
          <p className="pv-inherit"><Lock size={12} /> La base de ROI y los mínimos (+15%, 50 partidos) se heredan de la regla de avisos vigente al guardar y quedan congelados en el protocolo. Guardar no cambia los filtros de Telegram.</p>
          {errs.length > 0 && <ul className="pv-errs" role="alert" data-testid="list-paper-form-errors">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="pv-actions"><button className="button" disabled={errs.length > 0} onClick={toReview} data-testid="button-paper-review"><ClipboardCheck /> Revisar</button></div>
        </>
      ) : (
        <>
          <dl className="pv-review" data-testid="list-paper-review">{protocolLines(f).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          {create.isError && <div className="ws-notice error" role="alert" data-testid="status-paper-create-error"><div><strong>No se guardó el borrador</strong><p>{errorText(create.error, 'Error desconocido.')} Reintentar usa el mismo identificador y no duplica.</p></div></div>}
          <div className="pv-actions">
            <button className="button secondary" disabled={create.isPending} onClick={() => setReview(false)} data-testid="button-paper-edit"><ArrowLeft /> Editar</button>
            <button className="button" disabled={create.isPending} onClick={save} data-testid="button-paper-save">{create.isPending ? <LoaderCircle className="spin" /> : <Plus />}{create.isPending ? 'Guardando…' : 'Guardar borrador'}</button>
          </div>
        </>
      )}
    </section>
  );
}
