import { Router, type IRouter } from "express";
import { GetKalshiSignalsQueryParams, GetKalshiSignalsResponse } from "@workspace/api-zod";
import { getSignalEvaluation } from "../lib/kalshi-signal-store";

const router: IRouter = Router();
// Mounted after the existing /kalshi requireOwner middleware. This endpoint is
// read-only in both environments and cannot start a bot or create an activation.
router.get("/kalshi/signals", async (req, res): Promise<void> => {
  const parsed = GetKalshiSignalsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Página de señales no válida." }); return; }
  res.set("Cache-Control", "private, no-store");
  try {
    res.json(GetKalshiSignalsResponse.parse(await getSignalEvaluation(parsed.data.page ?? 1)));
  } catch (error) {
    req.log.error({ err: error }, "Prospective signal evaluation unavailable");
    res.status(503).json({ error: "No se pudo consultar la evaluación. La evidencia guardada se conserva; vuelve a intentarlo." });
  }
});
export default router;
