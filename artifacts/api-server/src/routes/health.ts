import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { archiveState } from "../lib/archive";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // Состояние архива — поле сверх сгенерированной схемы (lib/api-zod не
  // правим): parse его срезал бы, поэтому добавляем после. По нему deploy.sh
  // решает, принимать ли выкатку.
  res.json({ ...data, archive: archiveState() });
});

export default router;
