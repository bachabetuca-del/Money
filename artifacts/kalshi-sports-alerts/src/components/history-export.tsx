import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import {
  getDownloadKalshiHistoryUrl,
  getKalshiHistoryExportParts,
  type KalshiHistoryExportParts,
} from '@workspace/api-client-react';

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
  const [parts, setParts] = useState<KalshiHistoryExportParts | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  function run(format: Format) {
    setError('');
    setDone('');
    const link = document.createElement('a');
    link.href = getDownloadKalshiHistoryUrl({ format });
    link.target = '_blank';
    link.rel = 'noopener';
    link.download = `kalshi-historico.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setDone(`Se inició la descarga ${format.toUpperCase()}. Revisa Descargas; el navegador mostrará cualquier error.`);
  }

  async function prepareParts() {
    setPreparing(true);
    setError('');
    setDone('');
    try {
      setParts(await getKalshiHistoryExportParts());
    } catch (err) {
      setError(errorText(err, 'No se pudo preparar el historial por partes. Inténtalo de nuevo.'));
    } finally {
      setPreparing(false);
    }
  }

  function downloadPart(part: number) {
    if (!parts) return;
    setError('');
    const link = document.createElement('a');
    link.href = getDownloadKalshiHistoryUrl({
      format: 'json',
      part,
      snapshotAt: parts.snapshotAt,
    });
    link.target = '_blank';
    link.rel = 'noopener';
    link.download = `kalshi-historial-parte-${part}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setDone(`Se inició la parte ${part} de ${parts.parts.length}. Espera a que aparezca en Descargas antes de iniciar la siguiente.`);
  }

  return (
    <section className="ws-export" data-testid="history-export">
      <div className="ws-export-copy">
        <strong><Download size={14} /> Exportar todo el historial guardado</strong>
        <p>Incluye todas las bandas, partidos archivados y ejecuciones guardadas, sin aplicar los filtros de la pantalla. No es todo el historial de Kalshi. El JSON completo puede superar los 500 MB; para ChatGPT, prepara partes JSON de hasta 100,000 operaciones con el mismo corte.</p>
        {error && <p className="err" role="alert" data-testid="status-export-error">{error}</p>}
        {done && <p className="ok" role="status" data-testid="status-export-done">{done}</p>}
      </div>
      <div className="ws-tools">
        <button className="button secondary" onClick={() => void prepareParts()} disabled={preparing} data-testid="button-prepare-export-parts">
          <FileJson /> {preparing ? 'Preparando partes…' : 'Preparar partes para ChatGPT'}
        </button>
        <button className="button secondary" onClick={() => run('json')} data-testid="button-export-json">
          <FileJson /> JSON completo
        </button>
        <button className="button secondary" onClick={() => run('csv')} data-testid="button-export-csv">
          <FileSpreadsheet /> CSV para hojas
        </button>
      </div>
      {parts && (
        <div className="ws-export-parts" data-testid="history-export-parts">
          <p>
            {parts.totalTrades.toLocaleString()} operaciones · {parts.parts.length} archivos ·
            {' '}hasta {parts.rowsPerPart.toLocaleString()} operaciones por archivo.
            Descárgalos uno por uno; todos usan el corte {new Date(parts.snapshotAt).toLocaleString()}.
          </p>
          {parts.parts.length === 0
            ? <p>No hay operaciones guardadas para exportar.</p>
            : <div className="ws-tools">
              {parts.parts.map(({ part, trades }) => (
                <button
                  className="button secondary"
                  key={part}
                  onClick={() => downloadPart(part)}
                  data-testid={`button-export-part-${part}`}
                >
                  <FileJson /> Parte {part}/{parts.parts.length} · {trades.toLocaleString()}
                </button>
              ))}
            </div>}
        </div>
      )}
    </section>
  );
}
