import { Router, type IRouter } from "express";
import { GetKalshiNotificationsQueryParams, GetKalshiNotificationsResponse } from "@workspace/api-zod";
import { getTelegramNotifications } from "../lib/kalshi-notification-feed";

const router: IRouter = Router();
// Parent router requires the existing owner's verified sign-in. The owner chat
// is resolved server-side; no request parameter can select another destination.
router.get("/kalshi/notifications", async (req, res): Promise<void> => {
  const parsed = GetKalshiNotificationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Los filtros de avisos no son válidos." });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  try {
    res.json(GetKalshiNotificationsResponse.parse(await getTelegramNotifications(parsed.data)));
  } catch (error) {
    req.log.error({ err: error }, "Telegram notification history unavailable");
    res.status(503).json({ error: "No se pudieron cargar los avisos. El historial guardado se conserva; vuelve a intentarlo." });
  }
});

export default router;
