import { escapeHtml, betLabelEs, type MarketCardTrade } from "./telegram-market-card";
import { directionLabel, publicDirection } from "./telegram-trade-direction";
import { NOTIFICATION_MIN_ROI_PCT, notificationRoiBasis, qualifiesForNotificationRoi, type NotificationRoi, type RoiBasis } from "./telegram-notification-roi";
import { shouldCaptureTrade } from "./kalshi-trade-bands";
import type { SignalEvidence } from "@workspace/api-zod";
import { frozenNotification } from "./signal-evaluation";

export type NotificationTrade = MarketCardTrade & { tradeId: string; ticker: string; marketUrl: string; sport?: string };
export type NotificationJob = NotificationTrade & {
  sport: string; chatId: string; attempts: number; queuedAt?: Date;
  evaluationId?: number | null; evidence?: SignalEvidence;
};
type CleanupJob = { tradeId: string; messageId: number };

/** Startup snapshots and historical imports must never become fresh alerts. */
export function liveNotificationTrades<T extends { notional: number; createdTime: string }>(
  trades: T[], boundary: number | null,
) {
  if (boundary === null) return [];
  return trades.filter(trade => shouldCaptureTrade(trade.notional) &&
    new Date(trade.createdTime).getTime() > boundary);
}

export interface NotificationStore {
  next(chatId: string, now: Date): Promise<NotificationJob | undefined>;
  capture(job: NotificationJob, roi: NotificationRoi, now: Date): Promise<SignalEvidence | null>;
  sent(job: NotificationJob, messageId: number, now: Date): Promise<void>;
  skipped(job: NotificationJob, now: Date): Promise<void>;
  failed(chatId: string, tradeId: string, error: string, retryAt: Date): Promise<void>;
  latestMessageId(chatId: string): Promise<number | undefined>;
  cleanup(chatId: string, keep: number, now: Date): Promise<CleanupJob[]>;
  removed(chatId: string, tradeId: string, now: Date): Promise<void>;
}
export interface NotificationApi {
  request<T>(method: string, body: Record<string, unknown>): Promise<{ result?: T }>;
  context(ticker: string): Promise<{ eventTitle: string; marketTitle: string }>;
  roi(trade: NotificationJob, basis: RoiBasis): Promise<NotificationRoi | null>;
  active?(ticker: string): Promise<boolean>;
  observe?(event: NotificationObservation): void;
}
export type NotificationObservation = {
  stage: "dequeued" | "roi_started" | "roi_complete" | "decision" | "send_started" | "confirmed" | "failed";
  job: NotificationJob; at: Date; roi?: NotificationRoi | null; accepted?: boolean;
  reason?: string; telegramDate?: number; retryAfterMs?: number;
};

export function notificationText(trade: NotificationTrade, roi?: NotificationRoi) {
  const amount = trade.notional.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const direction = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
  const side = directionLabel(direction);
  const contracts = trade.count.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const price = (trade.price * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const time = trade.createdTime.toLocaleString("es-ES", { timeZone: "America/New_York",
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const sports: Record<string, string> = {
    Soccer: "Fútbol", Football: "Fútbol americano", Basketball: "Baloncesto", Tennis: "Tenis",
    Baseball: "Béisbol", Hockey: "Hockey", Esports: "Esports", Golf: "Golf",
    "Combat Sports": "Deportes de combate", Cricket: "Críquet", Motorsport: "Automovilismo",
  };
  const pct = (value: number | null) => value === null ? "no disponible" :
    `${value >= 0 ? "+" : ""}${value.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  return [
    `<b>${escapeHtml(trade.eventTitle ?? "Game details unavailable")}</b>`,
    ...(trade.sport ? [escapeHtml(sports[trade.sport] ?? trade.sport)] : []),
    "",
    `<b>Apuesta:</b> ${escapeHtml(betLabelEs(trade.marketTitle ?? "Apuesta no disponible"))}`,
    `<b>Posición:</b> ${direction === "yes" ? "SÍ · a favor" : direction === "no" ? "NO · en contra" : side}`,
    `<b>Precio:</b> ${price}¢ por contrato`,
    "",
    ...(roi ? [
      `<b>ROI histórico ${roi.basis === "net" ? "neto est." : "bruto"}: ${pct(roi.roiPct)}</b>`,
      roi.basis === "net" ? `Bruto: ${pct(roi.grossRoiPct)}` : `Neto estimado: ${pct(roi.netRoiPct)}`,
      `Base: ${roi.games.toLocaleString("es-ES")} partidos · ${roi.trades.toLocaleString("es-ES")} operaciones`,
      "",
    ] : []),
    `<b>Monto observado:</b> ${amount}`,
    `${contracts} contratos`,
    `Operación: ${time} · Nueva York`,
    "",
    "<i>No confirma una compra o venta. ROI histórico, no garantizado.</i>",
    ...(roi ? ["<blockquote expandable>Simulación: $100 por operación hasta liquidación. Neto con comisión taker actual; sin deslizamiento ni todos los costes personales. No son ganancias del trader.</blockquote>"] : []),
  ].join("\n");
}

/** Sends one short notification, then retires only older notification messages. */
export class TelegramTradeNotifications {
  private busy = false;
  constructor(
    private store: NotificationStore, private api: NotificationApi,
    private now: () => Date = () => new Date(),
    private log: (event: "sent" | "filtered" | "failed" | "cleanup-failed", detail: string) => void = () => undefined,
  ) {}
  private observe(event: Omit<NotificationObservation, "at">) {
    // Research is observational. A slow/unavailable research store must never
    // block, retry, suppress or duplicate an actual Telegram delivery.
    try { this.api.observe?.({ ...event, at: this.now() }); } catch { /* isolated observer */ }
  }

  async tick(settings: { enabled: boolean; chatId: string | null; notificationRoiBasis?: RoiBasis }) {
    if (this.busy || !settings.enabled || !settings.chatId) return;
    this.busy = true;
    const chatId = settings.chatId;
    try {
      const basis = notificationRoiBasis(settings.notificationRoiBasis);
      // Retire a bounded batch of filtered jobs, so they cannot block a qualifying
      // execution behind them. Still send at most one notification per tick.
      for (let checked = 0; checked < 10; checked++) {
        const job = await this.store.next(chatId, this.now());
        if (!job) break;
        this.observe({ stage: "dequeued", job });
        try {
          let frozen = job.evidence ? frozenNotification(job.evidence, job) : null;
          let trade = frozen?.trade ?? job;
          if (!shouldCaptureTrade(trade.notional)) throw new Error("Non-qualifying trade in notification queue.");
          if (this.api.active && !await this.api.active(trade.ticker)) {
            this.observe({ stage: "decision", job: trade, accepted: false, reason: "inactive_market" });
            await this.store.skipped(job, this.now());
            continue;
          }
          let roi = frozen?.roi;
          if (!frozen) {
            const context = await this.api.context(trade.ticker);
            if (!context.eventTitle || !context.marketTitle ||
              context.eventTitle.includes(trade.ticker) || context.marketTitle.includes(trade.ticker)) {
              throw new Error("Readable game and bet details are not available yet.");
            }
            trade = { ...trade, ...context };
            this.observe({ stage: "roi_started", job: trade });
            const currentRoi = await this.api.roi(trade, basis);
            this.observe({ stage: "roi_complete", job: trade });
            this.observe({ stage: "decision", job: trade, roi: currentRoi,
              accepted: qualifiesForNotificationRoi(currentRoi) && currentRoi.basis === basis,
              reason: "roi_or_sample" });
            if (!qualifiesForNotificationRoi(currentRoi) || currentRoi.basis !== basis) {
              await this.store.skipped(job, this.now());
              this.log("filtered", job.tradeId);
              continue;
            }
            roi = currentRoi;
            if (job.evaluationId != null) {
              const evidence = await this.store.capture(trade, roi, this.now());
              // A final settlement or stale eligibility found before capture
              // cannot be turned into a forward signal or delivered as one.
              if (!evidence) { await this.store.skipped(job, this.now()); continue; }
              frozen = frozenNotification(evidence, job);
              trade = frozen.trade; roi = frozen.roi;
            }
          }
          if (job.evidence) this.observe({ stage: "decision", job: trade, roi: roi ?? null,
            accepted: true, reason: "frozen_retry" });
          // A previously frozen retry keeps its original evidence, but cannot
          // bypass a stricter current cutoff. Never recompute it from later history.
          if (!roi || !Number.isFinite(roi.roiPct) || roi.roiPct < NOTIFICATION_MIN_ROI_PCT) {
            await this.store.skipped(job, this.now());
            this.log("filtered", job.tradeId);
            continue;
          }
          this.observe({ stage: "send_started", job: trade });
          const result = await this.api.request<{ message_id: number; date?: number }>("sendMessage", {
            chat_id: chatId,
            text: notificationText(trade, roi),
            parse_mode: "HTML",
            disable_notification: false,
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [[{ text: "Abrir en Kalshi", url: trade.marketUrl }]] },
          });
          if (!result.result?.message_id) throw new Error("Telegram did not confirm the notification message.");
          this.observe({ stage: "confirmed", job: trade, telegramDate: result.result.date });
          await this.store.sent(job, result.result.message_id, this.now());
          this.log("sent", job.tradeId);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Notification delivery failed.";
          const requestedDelay = Number(message.match(/retry after (\d+)/i)?.[1] ?? 0) * 1000;
          const delay = Math.max(requestedDelay, 15_000 * 2 ** Math.min(job.attempts, 5));
          this.observe({ stage: "failed", job, reason: "notification_retry", retryAfterMs: delay });
          await this.store.failed(chatId, job.tradeId, message, new Date(this.now().getTime() + delay));
          this.log("failed", message);
          break;
        }
      }
      const keep = await this.store.latestMessageId(chatId);
      if (keep === undefined) return;
      for (const old of await this.store.cleanup(chatId, keep, this.now())) {
        try {
          await this.api.request("deleteMessage", { chat_id: chatId, message_id: old.messageId });
          await this.store.removed(chatId, old.tradeId, this.now());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Notification cleanup failed.";
          if (/message to delete not found/i.test(message)) {
            await this.store.removed(chatId, old.tradeId, this.now());
          } else {
            await this.store.failed(chatId, old.tradeId, message, new Date(this.now().getTime() + 60_000));
            this.log("cleanup-failed", message);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
