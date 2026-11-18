import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import { getDownloadKalshiHistoryUrl } from '@workspace/api-client-react';

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
  const [done, setDone] = useState('');

  function run(format: Format) {
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

  return (
    <section className="ws-export" data-testid="history-export">
      <div className="ws-export-copy">
        <strong><Download size={14} /> Exportar todo el historial guardado</strong>
        <p>Ignora los filtros de deporte, banda y ventana: incluye todas las bandas, partidos archivados y todas las ejecuciones almacenadas, no solo las filas de la gráfica. Es lo que este monitor guardó, no todo el historial de Kalshi. El JSON añade metadatos y limitaciones para IA; el CSV es para hojas de cálculo.</p>
        {done && <p className="ok" role="status" data-testid="status-export-done">{done}</p>}
      </div>
      <div className="ws-tools">
        <button className="button secondary" onClick={() => run('json')} data-testid="button-export-json">
          <FileJson /> JSON para IA
        </button>
        <button className="button secondary" onClick={() => run('csv')} data-testid="button-export-csv">
          <FileSpreadsheet /> CSV para hojas
        </button>
      </div>
    </section>
  );
}
