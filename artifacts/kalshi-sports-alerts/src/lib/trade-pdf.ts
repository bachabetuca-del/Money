import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import type { ExplorerMarket, ExplorerTrade } from '@workspace/api-client-react';
import { yesQuote } from './explorer-model.ts';

export type TradePdfInput = {
  market: ExplorerMarket;
  trades: ExplorerTrade[];
  bandLabel: string;
  windowLabel: string;
  scopeLabel: string;
  directionLabel: string;
  search: string;
  loadedCount: number;
  totalCount: number;
  truncated: boolean;
  historyStatus: string;
  generatedAt: string;
};

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const number = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const date = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Sin fecha' : new Intl.DateTimeFormat('es-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d) + ' ET';
};
const direction = { yes: 'A favor (SÍ)', no: 'En contra (NO)', unknown: 'Sin dato' };

/** Exports the complete filtered snapshot, not just the table's visible page. */
export function buildTradePdf(input: TradePdfInput) {
  const { market, trades } = input;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `${market.gameName} - ${market.betLabel}`, author: 'Kalshi Sports Alerts', subject: 'Operaciones públicas guardadas de Kalshi' });
  const width = doc.internal.pageSize.getWidth();
  let y = 15;
  const line = (text: string, size = 10, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, width - 28);
    doc.text(lines, 14, y);
    y += lines.length * size * 0.4 + 2;
  };
  doc.setTextColor(22, 85, 66);
  line('FIELDNOTE / KALSHI SPORTS ALERTS', 10, true);
  line(market.gameName, 17, true);
  doc.setTextColor(40, 48, 44);
  line(`${market.sport} | ${market.gameDateLabel} | ${market.gameTimeLabel ?? 'Hora por confirmar'}`);
  line(`Mercado: ${market.betLabel}`, 11, true);
  line(`Ticker: ${market.ticker}`, 9);
  if (market.gameResult) line(`Marcador final: ${market.gameResult}`);
  line(`Sección: ${input.scopeLabel} | Rango: ${input.bandLabel} | Ventana: ${input.windowLabel}`);
  line(`Dirección: ${input.directionLabel}${input.search.trim() ? ` | ID contiene: ${input.search.trim()}` : ''}`);
  line(`Operaciones exportadas: ${number(trades.length)} | Importe total: ${money(trades.reduce((sum, t) => sum + t.notional, 0))}`, 11, true);
  line(`Datos actualizados: ${date(input.generatedAt)} | Todas las horas: Nueva York (ET)`, 9);
  line(input.truncated
    ? `EXPORTACIÓN PARCIAL: ${number(input.loadedCount)} operaciones cargadas de ${number(input.totalCount)} en esta ventana. El PDF incluye las que coinciden con tus filtros.`
    : 'Incluye todas las operaciones cargadas que coinciden con tus filtros; no solo las filas visibles.', 9);
  line(`Cobertura: ${input.historyStatus || 'Solo operaciones guardadas; no se garantiza todo el histórico de Kalshi.'}`, 9);
  line('SÍ y NO indican dirección pública, no una venta confirmada ni la identidad de un inversor.', 9);
  if (market.marketUrl) {
    doc.setTextColor(22, 85, 66);
    doc.textWithLink('Abrir mercado en Kalshi', 14, y, { url: market.marketUrl });
    y += 7;
  }
  autoTable(doc, {
    startY: y + 1,
    margin: { left: 14, right: 14, top: 14, bottom: 16 },
    head: [['Fecha y hora (ET)', 'Dirección', 'Precio', 'Cot. SÍ', 'Contratos', 'Importe USD', 'ID de operación']],
    body: trades.map(t => {
      const quote = yesQuote(t);
      return [date(t.createdTime), direction[t.direction], `${(t.price * 100).toFixed(2)}¢`,
        quote === null ? 'Sin dato' : `${(quote * 100).toFixed(2)}¢`,
        number(t.count), money(t.notional), t.tradeId];
    }),
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 2.5, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: [22, 85, 66], textColor: 255 },
    alternateRowStyles: { fillColor: [244, 246, 241] },
    columnStyles: {
      0: { cellWidth: 41 }, 1: { cellWidth: 29 },
      2: { cellWidth: 20, halign: 'right' }, 3: { cellWidth: 20, halign: 'right' },
      4: { cellWidth: 28, halign: 'right' }, 5: { cellWidth: 32, halign: 'right' },
      6: { cellWidth: 'auto' },
    },
    rowPageBreak: 'avoid',
  });
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100);
    const footerY = doc.internal.pageSize.getHeight() - 8;
    doc.text('Kalshi Sports Alerts | Datos públicos guardados | Importes en USD', 14, footerY);
    doc.text(`Página ${p} de ${pages}`, width - 14, footerY, { align: 'right' });
  }
  return doc;
}

export function tradePdfFilename(ticker: string, generatedAt: string) {
  return `operaciones-${ticker.replace(/[^a-zA-Z0-9_-]/g, '_')}-${generatedAt.slice(0, 10).replace(/[^0-9-]/g, '')}.pdf`;
}
