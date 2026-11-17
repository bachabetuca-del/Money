import { Router, type IRouter } from "express";
import { CreatePaperRunBody, CreatePaperRunResponse, GetPaperDashboardQueryParams, GetPaperDashboardResponse,
  ChangePaperRunStateParams, ChangePaperRunStateBody, ChangePaperRunStateResponse,
  GetPaperAuditResponse, ExportPaperRunQueryParams } from "@workspace/api-zod";
import { createPaperProtocol, changePaperState, paperDashboard, readRun } from "../lib/paper/repository";
import { paperRuntime } from "../lib/paper/runtime";
import { paperAudit } from "../lib/paper/audit";
import { PaperError } from "../lib/paper/protocol";
import { writePaperExport } from "../lib/paper/export";
import type { Request, Response } from "express";

const router: IRouter = Router();
function failure(req: Request, res: Response, error: unknown) {
  if (error instanceof PaperError) { res.status(error.status).json({ error: error.message }); return; }
  req.log.warn("Paper validation request failed; evidence was not discarded");
  res.status(503).json({ error: "No se pudo completar la consulta de prueba. La evidencia se conserva; vuelve a intentarlo." });
}
router.get("/kalshi/paper", async (req, res): Promise<void> => {
  const parsed = GetPaperDashboardQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Prueba o página no válida." }); return; }
  try {
    res.json(GetPaperDashboardResponse.parse(await paperDashboard(parsed.data.runId, parsed.data.page ?? 1, paperRuntime.canActivate)));
  } catch (error) { failure(req, res, error); }
});
router.post("/kalshi/paper/runs", async (req, res): Promise<void> => {
  const parsed = CreatePaperRunBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Revisa los valores y límites del protocolo." }); return; }
  try { res.status(201).json(CreatePaperRunResponse.parse(await createPaperProtocol(parsed.data))); }
  catch (error) { failure(req, res, error); }
});
router.post("/kalshi/paper/runs/:id/state", async (req, res): Promise<void> => {
  const id = ChangePaperRunStateParams.safeParse(req.params), parsed = ChangePaperRunStateBody.safeParse(req.body);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Prueba o acción no válida." }); return; }
  try { res.json(ChangePaperRunStateResponse.parse(await changePaperState(id.data.id, parsed.data.action, paperRuntime.canActivate))); }
  catch (error) { failure(req, res, error); }
});
router.get("/kalshi/paper/audit", async (req, res): Promise<void> => {
  try { res.json(GetPaperAuditResponse.parse(await paperAudit())); }
  catch (error) { failure(req, res, error); }
});
let exporting = false;
router.get("/kalshi/paper/export", async (req, res): Promise<void> => {
  const parsed = ExportPaperRunQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Prueba o formato no válido." }); return; }
  if (exporting) { res.status(429).json({ error: "Ya hay una exportación en curso; espera a que termine." }); return; }
  exporting = true;
  try {
    await readRun(parsed.data.id); // validate before starting the streamed body
    const format = parsed.data.format;
    res.type(format === "json" ? "application/json" : "text/csv");
    res.attachment(`fieldnote-prueba-${parsed.data.id}.${format}`);
    await writePaperExport(parsed.data.id, format, async chunk => {
      if (res.destroyed) throw new Error("Export download disconnected");
      if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
        const clean = () => { res.off("drain", drained); res.off("close", closed); res.off("error", failed); };
        const drained = () => { clean(); resolve(); };
        const closed = () => { clean(); reject(new Error("Export download disconnected")); };
        const failed = () => { clean(); reject(new Error("Export stream failed")); };
        res.once("drain", drained); res.once("close", closed); res.once("error", failed);
      });
    });
    res.end();
  } catch (error) {
    if (res.headersSent) res.destroy(); else failure(req, res, error);
  } finally { exporting = false; }
});
export default router;
