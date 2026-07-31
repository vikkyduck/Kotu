import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import transcriptionsRouter from "./transcriptions";
import documentsRouter from "./documents";
import lecturesRouter from "./lectures";
import decksRouter from "./decks";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();

// Публичные: проверка живости и вход.
router.use(healthRouter);
router.use(authRouter);

// Всё остальное — только после входа.
router.use(requireAuth);
router.use(transcriptionsRouter);
router.use(documentsRouter);
router.use(lecturesRouter);
router.use(decksRouter);

export default router;
