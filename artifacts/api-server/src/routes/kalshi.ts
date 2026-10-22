import { Router, type IRouter } from "express";
import {
  FindTelegramChatResponse,
  GetKalshiDashboardResponse,
  SaveKalshiSettingsBody,
  SaveKalshiSettingsResponse,
  SendTelegramTestBody,
  SendTelegramTestResponse,
} from "@workspace/api-zod";
import {
  findTelegramChat,
  getKalshiDashboard,
  saveKalshiSettings,
  sendTelegramTest,
} from "../lib/kalshi-monitor";
import { isOwnerChat } from "../lib/owner-policy";

const router: IRouter = Router();

function telegramErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Telegram request failed.";
  if (message.toLowerCase() === "not found") {
    return "Telegram rejected this bot token. Check the current token with BotFather, then replace TELEGRAM_BOT_TOKEN in Replit Secrets.";
  }
  if (message.toLowerCase().includes("getupdates") && message.toLowerCase().includes("webhook")) {
    return "Telegram has a webhook configured for this bot, so chat discovery via /start is unavailable. Remove the webhook or use a bot without one.";
  }
  return message;
}

router.get("/kalshi/dashboard", async (_req, res): Promise<void> => {
  const data = await getKalshiDashboard();
  res.json(GetKalshiDashboardResponse.parse(data));
});

router.put("/kalshi/settings", async (req, res): Promise<void> => {
  const parsed = SaveKalshiSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isOwnerChat(parsed.data.chatId.trim())) {
    res.status(400).json({ error: "The Telegram destination is locked to the owner. Change TELEGRAM_OWNER_CHAT_ID in deployment settings to move it." });
    return;
  }

  if (parsed.data.enabled && !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    res.status(400).json({
      error: "Add a Telegram bot token before enabling alerts.",
    });
    return;
  }

  await saveKalshiSettings({
    enabled: parsed.data.enabled,
    minimumNotional: parsed.data.minimumNotional,
    chatId: parsed.data.chatId.trim(),
  });
  const data = await getKalshiDashboard();
  res.json(SaveKalshiSettingsResponse.parse(data));
});

router.post(
  "/kalshi/telegram/find-chat",
  async (_req, res): Promise<void> => {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
      res.status(400).json({ error: "Telegram bot token is not configured." });
      return;
    }
    try {
      const result = await findTelegramChat();
      res.json(FindTelegramChatResponse.parse(result));
    } catch (error) {
      res.status(400).json({ error: telegramErrorMessage(error) });
    }
  },
);

router.post("/kalshi/telegram/test", async (req, res): Promise<void> => {
  const parsed = SendTelegramTestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isOwnerChat(parsed.data.chatId.trim())) {
    res.status(400).json({ error: "Only the owner's Telegram chat can receive this dashboard." });
    return;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    res.status(400).json({ error: "Telegram bot token is not configured." });
    return;
  }

  try {
    await sendTelegramTest(parsed.data.chatId.trim());
    res.json(
      SendTelegramTestResponse.parse({
        success: true,
        message: "Live Telegram dashboard refreshed. Use its sport, game, and market buttons.",
      }),
    );
  } catch (error) {
    res.status(400).json({ error: telegramErrorMessage(error) });
  }
});

export default router;
