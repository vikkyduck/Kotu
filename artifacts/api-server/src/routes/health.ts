import { Router, type IRouter } from "express";
import { archiveState } from "../lib/archive";

const router: IRouter = Router();

// По полю archive deploy.sh решает, принимать ли выкатку.
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", archive: archiveState() });
});

export default router;
