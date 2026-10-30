import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, RefreshCw, Sparkles } from 'lucide-react';
import {
  getGetKalshiAnalysisQueryKey,
  useAnalyzeKalshiGame,
  useGetKalshiAnalysis,
  type GameAnalysis,
  type GameAnalysisState,
} from '@workspace/api-client-react';
import { errorText, saveBlob } from '@/components/history-export';

const TZ = 'America/New_York';
function when(v: string | null) {
  if (!v) return 'sin dato';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('es-US', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' ET';
}

function downloadTxt(a: GameAnalysis) {
  const head = [
    'Fieldnote / Kalshi - Análisis de partido (IA)',
    `Partido: ${a.gameName}`,
    `Apuesta seleccionada: ${a.betLabel} (${a.ticker})`,
    `Generado: ${when(a.generatedAt)} · Modelo: ${a.model}`,
    `Datos hasta: ${when(a.dataThrough)} · Última operación: ${when(a.latestTradeAt)}`,
    `Alcance: todas las bandas y mercados guardados del partido · ${a.totalTrades} operaciones · ${a.includedMarkets} de ${a.totalMarkets} mercados incluidos`,
    'Limitaciones: basado solo en operaciones públicas guardadas; sin estado deportivo en directo, lesiones, alineaciones ni cuotas en vivo verificadas. No es un modelo de probabilidad de ganar ni datos de ventas confirmadas. Instantánea, no recomendación en vivo.',
    '',
    '----------------------------------------',
    '',
  ].join('\n');
  const safe = a.ticker.replace(/[^A-Za-z0-9_-]/g, '_');
  saveBlob(new Blob([head + a.text + '\n'], { type: 'text/plain;charset=utf-8' }), `analisis-${safe}-${a.generatedAt.slice(0, 10)}.txt`);
}

export function GameAnalysisPanel({ ticker }: { ticker: string }) {
  const qc = useQueryClient();
  const params = { ticker };
  const key = getGetKalshiAnalysisQueryKey(params);
  const saved = useGetKalshiAnalysis(params, { query: { queryKey: key, refetchInterval: 60_000, retry: false, enabled: ticker.length > 0 } });
  const analyze = useAnalyzeKalshiGame();
  const busy = useRef(false);

  function generate() {
    if (busy.current || !ticker) return;
    busy.current = true;
    const reqKey = getGetKalshiAnalysisQueryKey({ ticker });
    analyze.mutate({ data: { ticker } }, {
      onSuccess: (result) => {
        // Write only under the ticker that was requested, never the current view.
        qc.setQueryData<GameAnalysisState>(reqKey, (old) => ({ available: old?.available ?? true, analysis: result }));
        void qc.invalidateQueries({ queryKey: reqKey, exact: true });
      },
      onSettled: () => { busy.current = false; },
    });
  }

  const state = saved.data;
  const a = state?.analysis ?? null;
  const unavailable = state?.available === false;
  const pending = analyze.isPending;

  return (
    <section className="ws-card ws-ai" data-testid="game-analysis-panel">
      <header className="row">
        <div>
          <h3><Sparkles size={15} /> Análisis IA del partido</h3>
          <p>Por apuesta seleccionada, con contexto de todo el partido: todas las bandas y mercados guardados. No usa la banda, ventana ni rango de la gráfica.</p>
        </div>
        <div className="ws-tools">
          {a && <button className="button secondary" onClick={() => downloadTxt(a)} data-testid="button-download-analysis-txt"><Download /> Descargar .txt</button>}
          <button className="button" onClick={generate} disabled={pending || unavailable || saved.isLoading || saved.isError} data-testid="button-generate-analysis">
            {pending ? <RefreshCw className="spin" /> : <Sparkles />}
            {pending ? 'Generando…' : a ? 'Regenerar análisis' : 'Generar análisis'}
          </button>
        </div>
      </header>

      <div className="ws-ai-body">
        <div className="ws-ai-cost" data-testid="text-analysis-cost">
          <strong>Costo:</strong> usa Replit AI Integrations (OpenAI) y se cobra a tus créditos solo cuando pulsas generar. Ver el informe guardado es gratis y no llama a la IA.
        </div>
        {unavailable && <div className="ws-notice warn" role="status" data-testid="status-analysis-unavailable"><div><strong>Análisis IA no disponible</strong><p>La integración de IA no está configurada en este entorno; la generación está desactivada.</p></div></div>}
        {analyze.isError && <div className="ws-notice error" role="alert" data-testid="status-analysis-error"><div><strong>No se generó el análisis</strong><p>{errorText(analyze.error, 'Error desconocido.')}</p></div></div>}
        {saved.isError && <div className="ws-notice error" role="alert"><div><strong>No se pudo leer el informe guardado</strong><p>{errorText(saved.error, 'Error desconocido.')}</p></div><button className="button secondary" onClick={() => void saved.refetch()} data-testid="button-retry-analysis"><RefreshCw /> Reintentar</button></div>}
        {saved.isLoading && <div className="skeleton" style={{ height: 120 }} />}
        {pending && <div className="skeleton" style={{ height: 80 }} data-testid="loading-analysis" />}

        {state && !a && !unavailable && !pending && (
          <div className="ws-empty small" data-testid="empty-analysis"><FileText size={18} /><br />Aún no hay informe guardado para esta apuesta. Nada se genera automáticamente.</div>
        )}

        {a && (
          <article data-testid="analysis-report">
            <div className="ws-ai-meta">
              <span>Generado {when(a.generatedAt)}</span>
              <span>Datos hasta {when(a.dataThrough)}</span>
              <span>Última operación {when(a.latestTradeAt)}</span>
              <span>{a.totalTrades.toLocaleString('en-US')} operaciones · {a.includedMarkets} de {a.totalMarkets} mercados · todas las bandas</span>
              <span>Modelo {a.model}</span>
            </div>
            <p className="ws-sub"><strong>{a.gameName}</strong> · {a.betLabel}</p>
            {a.includedMarkets < a.totalMarkets && <p className="ws-sub warn" style={{ padding: 0 }}>Cobertura limitada: el informe incluyó {a.includedMarkets} de {a.totalMarkets} mercados del partido.</p>}
            <p className="ws-ai-snap">Instantánea fija hasta {when(a.dataThrough)}; la gráfica del mercado puede contener datos más recientes. El estado en directo del partido no está verificado por este informe. No es una recomendación en vivo.</p>
            <div className="ws-ai-text" data-testid="text-analysis">{a.text}</div>
          </article>
        )}
        <p className="ws-ai-limits">Se basa solo en operaciones públicas guardadas. No verifica lesiones, alineaciones ni cuotas en vivo; no es un modelo de probabilidad de ganar ni prueba ventas confirmadas.</p>
      </div>
    </section>
  );
}
