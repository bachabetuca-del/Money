import sharp from "sharp";
import { logger } from "./logger";
import { marketCardCaption, marketCardSvg, type MarketCardTrade } from "./telegram-market-card";
import {
  buildCatalog, chartKeyboard, HOME, keyFor, menuSvg, menuView,
  navigate, normalizeSelection, type MarketSummary, type Selection,
} from "./telegram-dashboard-view";

export type DashboardState = Selection & {
  chatId: string;
  messageId: number | null;
  contentHash: string | null;
  cleanupComplete: boolean;
  cleanupWarning: string | null;
};
export type DashboardTrade = MarketCardTrade & { marketUrl: string };
export type DashboardSettings = { enabled: boolean; minimumNotional: number; chatId: string | null };
export type CallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number | string } };
};
export interface DashboardStore {
  state(chatId: string): Promise<DashboardState | undefined>;
  save(state: DashboardState): Promise<void>;
  markets(threshold: number): Promise<MarketSummary[]>;
  trades(ticker: string, threshold: number): Promise<DashboardTrade[]>;
  context(ticker: string, context: { eventTitle: string; marketTitle: string }): Promise<void>;
  oldCards(chatId: string): Promise<{ ticker: string; messageId: number }[]>;
  retire(ticker: string): Promise<void>;
  publishedThrough(cutoff: Date, tickers: string[]): Promise<void>;
}
type TelegramResult<T> = { result?: T };
export interface DashboardApi {
  request<T>(method: string, body?: Record<string, unknown>): Promise<TelegramResult<T>>;
  photo<T>(method: "sendPhoto" | "editMessageMedia", fields: Record<string, string>, png: Buffer): Promise<TelegramResult<T>>;
  context(ticker: string): Promise<{ eventTitle: string; marketTitle: string }>;
}

export class TelegramDashboard {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private store: DashboardStore, private api: DashboardApi) {}

  private async serialized<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(chatId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(chatId) === current) this.queues.delete(chatId);
    }
  }

  async sync(settings: DashboardSettings, home = false) {
    if (!settings.chatId) return;
    const chatId = settings.chatId;
    return this.serialized(chatId, () => this.render(chatId, settings, home ? "d:home" : undefined));
  }

  async callback(query: CallbackQuery, settings: DashboardSettings) {
    const chatId = query.message ? String(query.message.chat.id) : "";
    const state = chatId ? await this.store.state(chatId) : undefined;
    const allowed = Boolean(settings.chatId === chatId && state?.messageId === query.message?.message_id &&
      query.data?.startsWith("d:"));
    try {
      await this.api.request("answerCallbackQuery", {
        callback_query_id: query.id,
        ...(allowed ? {} : { text: "This card is inactive. Use /menu in the linked chat." }),
      });
    } catch {
      // An expired callback acknowledgement must not create a new chat message.
    }
    if (!allowed) return;
    try {
      await this.serialized(chatId, async () => {
        const latest = await this.store.state(chatId);
        if (latest?.messageId !== query.message?.message_id) return;
        return this.render(chatId, settings, query.data);
      });
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : "Navigation failed" }, "Telegram dashboard navigation failed");
      // No sendMessage fallback: failures must never produce duplicate graph cards.
      throw error;
    }
  }

  private async render(chatId: string, settings: DashboardSettings, action?: string) {
    const cutoff = new Date();
    let state = await this.store.state(chatId);
    if (!state) {
      const old = await this.store.oldCards(chatId);
      // Reuse one existing photo message; do not add a new card during migration.
      state = {
        ...HOME, chatId, messageId: old[0]?.messageId ?? null,
        contentHash: null, cleanupComplete: false, cleanupWarning: null,
      };
    }
    let summaries = await this.store.markets(settings.minimumNotional);
    const missingNames = summaries.filter(row => !row.eventTitle || !row.marketTitle ||
      row.marketTitle.includes(row.ticker) || row.eventTitle.includes(row.ticker));
    if (!action && missingNames.length) {
      await Promise.all(missingNames.slice(0, 5).map(async row => {
        try {
          await this.store.context(row.ticker, await this.api.context(row.ticker));
        } catch {
          logger.debug({ ticker: row.ticker }, "Dashboard metadata unavailable; retrying on the next refresh");
        }
      }));
      summaries = await this.store.markets(settings.minimumNotional);
    }
    const catalog = buildCatalog(summaries);
    let selection = normalizeSelection(state, catalog);
    if (action) selection = normalizeSelection(navigate(selection, action, catalog), catalog);
    let svg: string;
    let caption: string;
    let keyboard;
    if (selection.screen === "chart") {
      const market = catalog.find(item => item.ticker === selection.ticker)!;
      const context = await this.api.context(market.ticker);
      await this.store.context(market.ticker, context);
      const rows = (await this.store.trades(market.ticker, settings.minimumNotional)).map(row => ({ ...row, ...context }));
      if (!rows.length) throw new Error("No qualifying trades are available for this market.");
      svg = marketCardSvg(rows, settings.minimumNotional);
      caption = marketCardCaption(rows[rows.length - 1]) +
        (settings.enabled ? "\nLive · checks every 15 seconds." : "\nMonitoring paused · saved history.");
      keyboard = chartKeyboard(selection, market.marketUrl);
    } else {
      const view = menuView(selection, catalog, settings.enabled, settings.minimumNotional);
      selection = { ...selection, page: view.page };
      svg = menuSvg(view);
      caption = view.caption;
      keyboard = view.keyboard;
    }
    const contentHash = keyFor(svg + caption + JSON.stringify(keyboard));
    let messageId = state.messageId;
    if (state.contentHash !== contentHash || messageId === null) {
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      const replyMarkup = JSON.stringify(keyboard);
      if (messageId !== null) {
        try {
          await this.api.photo("editMessageMedia", {
            chat_id: chatId, message_id: String(messageId), reply_markup: replyMarkup,
            media: JSON.stringify({ type: "photo", media: "attach://photo", caption, parse_mode: "HTML" }),
          }, png);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/message to edit not found/i.test(message)) {
            // Replacement is allowed only when the previous dashboard no longer exists.
            messageId = null;
          } else if (!/message is not modified/i.test(message)) {
            throw error;
          }
        }
      }
      if (messageId === null) {
        const sent = await this.api.photo<{ message_id: number }>("sendPhoto", {
          chat_id: chatId, caption, parse_mode: "HTML", reply_markup: replyMarkup,
        }, png);
        if (!sent.result?.message_id) throw new Error("Telegram did not return a dashboard message ID.");
        messageId = sent.result.message_id;
      }
      state = { ...state, ...selection, messageId, contentHash };
      await this.store.save(state);
    }
    await this.store.publishedThrough(cutoff, catalog.map(market => market.ticker));
    if (!state.cleanupComplete) await this.cleanup(state);
    return state;
  }

  private async cleanup(state: DashboardState) {
    let removed = 0;
    const warnings: string[] = [];
    for (const card of await this.store.oldCards(state.chatId)) {
      if (card.messageId !== state.messageId) {
        try {
          await this.api.request("deleteMessage", { chat_id: state.chatId, message_id: card.messageId });
          removed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Deletion failed";
          if (!/message to delete not found/i.test(message)) warnings.push(message);
        }
      }
      // Retiring a message mapping never removes the saved public trade history.
      await this.store.retire(card.ticker);
    }
    state.cleanupComplete = true;
    state.cleanupWarning = warnings.length ? `${warnings.length} older cards could not be removed: ${warnings.join("; ")}` : null;
    await this.store.save(state);
    logger.info({ removed, warnings: warnings.length }, "Telegram single-dashboard migration complete");
    if (state.cleanupWarning) logger.warn({ warning: state.cleanupWarning }, "Older Telegram card cleanup incomplete");
  }
}
