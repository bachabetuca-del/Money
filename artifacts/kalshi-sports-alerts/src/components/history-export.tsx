import { useRef, useState } from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import { downloadKalshiHistory } from '@workspace/api-client-react';

type Format = 'json' | 'csv';

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function errorText(err: unknown, fallback: string) {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === 'string' && data.error) return data.error;
  return err instanceof Error && err.message ? err.message : fallback;
}

export function HistoryExport() {
  const [pending, setPending] = useState<Format | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const busy = useRef(false);

  async function run(format: Format) {
    if (busy.current) return;
    busy.current = true;
    setPending(format);
    setError('');
    setDone('');
    try {
      const blob = await downloadKalshiHistory({ format }, { responseType: 'blob' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveBlob(blob, `fieldnote-kalshi-historial-${stamp}.${format}`);
      setDone(format === 'json' ? 'JSON descargado.' : 'CSV descargado.');
    } catch (err) {
      setError(errorText(err, 'No se pudo descargar el historial. Inténtalo de nuevo.'));
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <section className="ws-export" data-testid="history-export">
      <div className="ws-export-copy">
        <strong><Download size={14} /> Exportar todo el historial guardado</strong>
        <p>Ignora los filtros de deporte, banda y ventana: incluye todas las bandas, partidos archivados y todas las ejecuciones almacenadas, no solo las filas de la gráfica. Es lo que este monitor guardó, no todo el historial de Kalshi. El JSON añade metadatos y limitaciones para IA; el CSV es para hojas de cálculo.</p>
        {error && <p className="err" role="alert" data-testid="status-export-error">{error}</p>}
        {done && !error && <p className="ok" role="status" data-testid="status-export-done">{done}</p>}
      </div>
      <div className="ws-tools">
        <button className="button secondary" disabled={pending !== null} onClick={() => void run('json')} data-testid="button-export-json">
          <FileJson /> {pending === 'json' ? 'Preparando JSON…' : 'JSON para IA'}
        </button>
        <button className="button secondary" disabled={pending !== null} onClick={() => void run('csv')} data-testid="button-export-csv">
          <FileSpreadsheet /> {pending === 'csv' ? 'Preparando CSV…' : 'CSV para hojas'}
        </button>
      </div>
    </section>
  );
}
