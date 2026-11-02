import { Router, type IRouter } from "express";
import healthRouter from "./health";
import kalshiRouter from "./kalshi";
import { requireOwner } from "../middlewares/requireOwner";
import signalsRouter from "./signals";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/kalshi", requireOwner);
router.use(kalshiRouter);
router.use(signalsRouter);
router.use(notificationsRouter);

export default router;
