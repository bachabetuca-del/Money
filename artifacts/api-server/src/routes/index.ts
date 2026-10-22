import { Router, type IRouter } from "express";
import healthRouter from "./health";
import kalshiRouter from "./kalshi";
import { requireOwner } from "../middlewares/requireOwner";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/kalshi", requireOwner);
router.use(kalshiRouter);

export default router;
