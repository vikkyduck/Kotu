import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// API слушает 127.0.0.1 за nginx на этом же хосте. Без trust proxy req.ip у всех
// был бы адресом nginx, и лимитер входа стал бы одним на весь интернет.
// Доверяем только loopback: берётся самый правый адрес X-Forwarded-For, который
// дописал наш nginx, а всё, что клиент подсунул левее, игнорируется.
app.set("trust proxy", "loopback");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
