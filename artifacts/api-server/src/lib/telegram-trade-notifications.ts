import { escapeHtml, betLabelEs, type MarketCardTrade } from "./telegram-market-card";
import { directionLabel, directionMeaning, publicDirection, DIRECTION_NOTE } from "./telegram-trade-direction";
import { notificationRoiBasis, qualifiesForNotificationRoi, type NotificationRoi, type RoiBasis } from "./telegram-notification-roi";
import { shouldCaptureTrade } from "./kalshi-trade-bands";

export type NotificationTrade = MarketCardTrade & { tradeId: string; ticker: string; marketUrl: string };
export type NotificationJob = NotificationTrade & { sport: string; chatId: string; attempts: number };
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
}

export function notificationText(trade: NotificationTrade, roi?: NotificationRoi) {
  const amount = trade.notional.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const direction = publicDirection(trade.outcomeSide, undefined, trade.bookSide);
  const side = directionLabel(direction);
  const contracts = trade.count.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const price = (trade.price * 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const time = trade.createdTime.toLocaleString("en-US", { timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const pct = (value: number | null) => value === null ? "no disponible" :
    `${value >= 0 ? "+" : ""}${value.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  return [
    `<b>${amount} · operación deportiva</b>`,
    `<b>${escapeHtml(trade.eventTitle ?? "Game details unavailable")}</b>`,
    `${side}${direction === "unknown" ? " · " : " «"}${escapeHtml(betLabelEs(trade.marketTitle ?? "Apuesta no disponible"))}${direction === "unknown" ? "" : "»"}`,
    direction === "unknown" ? "" : `<b>${directionMeaning(direction)}</b>`,
    `${contracts} contratos a ${price}¢`,
    ...(roi ? [
      `<b>ROI histórico comparable (${direction === "yes" ? "SÍ" : "NO"})</b>`,
      `Bruto: ${pct(roi.grossRoiPct)} · Neto estimado: ${pct(roi.netRoiPct)}`,
      `<b>Filtro elegido: ${roi.basis === "net" ? "neto estimado" : "bruto"} ≥ +7,0%</b>`,
      `${roi.games.toLocaleString("es-ES")} partidos · ${roi.trades.toLocaleString("es-ES")} operaciones verificadas`,
      "<i>$100 por operación; neto con comisión taker actual, hasta liquidación y sin deslizamiento. No son ganancias del trader ni una garantía.</i>",
    ] : []),
    time,
    `<i>${DIRECTION_NOTE}</i>`,
  ].filter(Boolean).join("\n");
}

/** Sends one short notification, then retires only older notification messages. */
export class TelegramTradeNotifications {
  private busy = false;
  constructor(
    private store: NotificationStore, private api: NotificationApi,
    private now: () => Date = () => new Date(),
    private log: (event: "sent" | "filtered" | "failed" | "cleanup-failed", detail: string) => void = () => undefined,
  ) {}

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
        try {
          if (!shouldCaptureTrade(job.notional)) throw new Error("Non-qualifying trade in notification queue.");
          if (this.api.active && !await this.api.active(job.ticker)) {
            await this.store.skipped(job, this.now());
            continue;
          }
          const context = await this.api.context(job.ticker);
          if (!context.eventTitle || !context.marketTitle ||
            context.eventTitle.includes(job.ticker) || context.marketTitle.includes(job.ticker)) {
            throw new Error("Readable game and bet details are not available yet.");
          }
          const roi = await this.api.roi({ ...job, ...context }, basis);
          if (!qualifiesForNotificationRoi(roi) || roi.basis !== basis) {
            await this.store.skipped(job, this.now());
            this.log("filtered", job.tradeId);
            continue;
          }
          const result = await this.api.request<{ message_id: number }>("sendMessage", {
            chat_id: chatId,
            text: notificationText({ ...job, ...context }, roi),
            parse_mode: "HTML",
            disable_notification: false,
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [[{ text: "Abrir en Kalshi", url: job.marketUrl }]] },
          });
          if (!result.result?.message_id) throw new Error("Telegram did not confirm the notification message.");
          await this.store.sent(job, result.result.message_id, this.now());
          this.log("sent", job.tradeId);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Notification delivery failed.";
          const requestedDelay = Number(message.match(/retry after (\d+)/i)?.[1] ?? 0) * 1000;
          const delay = Math.max(requestedDelay, 15_000 * 2 ** Math.min(job.attempts, 5));
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
