import http from "node:http";
import { logger } from "./logger";

/**
 * Сообщение владелице в Telegram через мост ПСИ (psy-platform-bridge).
 * Токен бота живет у агента, платформа его не видит: она только передает
 * текст по Unix-сокету, а мост отправляет его в личку владелицы.
 *
 * Возвращает true, если владелица сообщение получила: мост его отправил
 * (200, sent) или такое же уже ушло в последние 10 минут (200, duplicate).
 * false - сообщение не ушло: мост недоступен, исчерпан часовой лимит
 * сообщений (429), мост не настроен (503) или Telegram не принял (502).
 */
export async function notifyOwner(text: string): Promise<boolean> {
  if ((process.env["NOTIFY_OWNER"] ?? "on") === "off") return false;
  const socketPath = process.env["CODEX_BRIDGE_SOCKET"] ?? "/run/psy-platform-bridge.sock";
  const data = Buffer.from(JSON.stringify({ text: text.slice(0, 3500) }));

  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: "/notify",
        method: "POST",
        headers: { host: "psy-platform-bridge", "content-type": "application/json", "content-length": data.length },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let reason = "";
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sent?: boolean; reason?: string };
            if (status === 200 && (body.sent === true || body.reason === "duplicate")) return resolve(true);
            reason = typeof body.reason === "string" ? body.reason : "";
          } catch {
            // тело не JSON - сообщение считаем неотправленным
          }
          logger.warn({ status, reason }, "Мост не отправил уведомление владелице");
          resolve(false);
        });
        res.on("error", () => resolve(false));
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      logger.warn({ code: (err as NodeJS.ErrnoException).code ?? err.message }, "Мост уведомлений недоступен");
      resolve(false);
    });
    req.end(data);
  });
}
