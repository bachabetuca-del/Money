import { Router, type IRouter } from "express";
import {
  FindTelegramChatResponse,
  GetKalshiDashboardResponse,
  SaveKalshiSettingsBody,
  SaveKalshiSettingsResponse,
  SendTelegramTestBody,
  SendTelegramTestResponse,
  GetKalshiExplorerQueryParams,
  GetKalshiExplorerResponse,
  DownloadKalshiHistoryQueryParams,
  GetKalshiHistoryExportPartsResponse,
  GetKalshiAnalysisQueryParams,
  GetKalshiAnalysisResponse,
  AnalyzeKalshiGameBody,
  AnalyzeKalshiGameResponse,
  GetKalshiLeaderboardQueryParams,
  GetKalshiLeaderboardResponse,
  GetKalshiExplorerRoiQueryParams,
  GetKalshiExplorerRoiResponse,
} from "@workspace/api-zod";
import {
  findTelegramChat,
  getKalshiDashboard,
  saveKalshiSettings,
  sendTelegramTest,
} from "../lib/kalshi-monitor";
import { isOwnerChat } from "../lib/owner-policy";
import { getKalshiExplorer } from "../lib/kalshi-explorer";
import { kalshiLiveEvents } from "../lib/kalshi-live-events";
import { getKalshiHistoryExportParts, streamHistoryExport } from "../lib/kalshi-history-export";
import { analysisAvailable, gameAnalysisService, loadGameAnalysis } from "../lib/kalshi-game-analysis";
import { AnalysisError } from "../lib/game-analysis";
import { getRoiLeaderboard } from "../lib/kalshi-roi-leaderboard";
import { getExplorerRoi } from "../lib/kalshi-explorer-roi";

const router: IRouter = Router();
// The parent router applies requireOwner to ALL /kalshi routes, including SSE.
router.get("/kalshi/live", (req, res) => kalshiLiveEvents.serve(req, res));
router.get("/kalshi/explorer/roi", async (req, res): Promise<void> => {
  const parsed = GetKalshiExplorerRoiQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Filtros del contexto ROI no válidos." }); return; }
  res.set("Cache-Control", "private, no-store");
  try {
    const data = await getExplorerRoi(parsed.data.band ?? "large", parsed.data.scope ?? "active");
    res.json(GetKalshiExplorerRoiResponse.parse(data));
  } catch {
    res.status(503).json({ error: "No se pudo actualizar el contexto ROI. Los mercados y sus gráficas siguen disponibles." });
  }
});
router.get("/kalshi/leaderboard", async (req, res): Promise<void> => {
  const parsed = GetKalshiLeaderboardQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Filtros del ranking no válidos." }); return; }
  res.set("Cache-Control", "private, no-store");
  try {
    const data = await getRoiLeaderboard({
      groupBy: parsed.data.groupBy ?? "segment", window: parsed.data.window ?? "all",
      sortBy: parsed.data.sortBy ?? "roi",
      band: parsed.data.band ?? "all", direction: parsed.data.direction ?? "all",
      minGames: parsed.data.minGames ?? 10, page: parsed.data.page ?? 1,
      coverage: parsed.data.coverage ?? "verified",
    });
    res.json(GetKalshiLeaderboardResponse.parse(data));
  } catch {
    res.status(503).json({ error: "No se pudo actualizar el ranking. Inténtalo de nuevo; el histórico se conserva." });
  }
});
let exportInProgress = false;
router.get("/kalshi/history/export/parts", async (_req, res): Promise<void> => {
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(GetKalshiHistoryExportPartsResponse.parse(await getKalshiHistoryExportParts()));
  } catch {
    res.status(503).json({ error: "No se pudo preparar la lista de partes. Inténtalo de nuevo." });
  }
});
router.get("/kalshi/history/export", async (req, res): Promise<void> => {
  const parsed = DownloadKalshiHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Elige JSON o CSV." }); return; }
  const { part, snapshotAt, format } = parsed.data;
  if ((part === undefined) !== (snapshotAt === undefined) || (part !== undefined && format !== "json")) {
    res.status(400).json({ error: "Las partes requieren JSON y el corte de la lista preparada." });
    return;
  }
  if (exportInProgress) {
    res.status(429).json({ error: "Hay otra descarga en curso. Espera a que termine." });
    return;
  }
  exportInProgress = true;
  try {
    await streamHistoryExport(req, res, format,
      part !== undefined && snapshotAt !== undefined ? { part, snapshotAt: new Date(snapshotAt) } : undefined);
  }
  catch {
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: "No se pudo completar la descarga del histórico. Inténtalo de nuevo." });
  } finally { exportInProgress = false; }
});
router.get("/kalshi/analysis", async (req, res): Promise<void> => {
  const parsed = GetKalshiAnalysisQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Selecciona un mercado válido." }); return; }
  res.set("Cache-Control", "private, no-store");
  res.json(GetKalshiAnalysisResponse.parse({
    available: analysisAvailable(), analysis: await loadGameAnalysis(parsed.data.ticker),
  }));
});
router.post("/kalshi/analysis", async (req, res): Promise<void> => {
  const parsed = AnalyzeKalshiGameBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Selecciona un mercado válido." }); return; }
  if (!analysisAvailable()) { res.status(503).json({ error: "La integración de IA no está disponible en este entorno." }); return; }
  try {
    const report = await gameAnalysisService.generate(parsed.data.ticker);
    res.set("Cache-Control", "private, no-store");
    res.json(AnalyzeKalshiGameResponse.parse(report));
  } catch (error) {
    if (error instanceof AnalysisError) {
      if (error.status === 429) res.set("Retry-After", "60");
      res.status(error.status).json({ error: error.message });
    } else {
      res.status(500).json({ error: "No se pudo guardar el informe. El informe anterior se conserva." });
    }
  }
});

router.get("/kalshi/explorer", async (req, res): Promise<void> => {
  const parsed = GetKalshiExplorerQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Filtros de mercado no válidos." });
    return;
  }
  const data = await getKalshiExplorer({
    band: parsed.data.band ?? "large", scope: parsed.data.scope ?? "active",
    ticker: parsed.data.ticker, window: parsed.data.window ?? "all",
    direction: parsed.data.direction ?? "all",
    marketType: parsed.data.marketType ?? "all",
    view: parsed.data.view ?? "full",
  });
  res.json(GetKalshiExplorerResponse.parse(data));
});

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
    notificationRoiBasis: parsed.data.notificationRoiBasis,
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
  if (process.env.BOT_WORKERS_ENABLED === "false") {
    res.status(409).json({ error: "Telegram está desactivado en desarrollo para no interferir con el bot publicado. Actualiza el menú desde el website publicado." });
    return;
  }
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
