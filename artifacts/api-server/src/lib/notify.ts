import http from "node:http";
import { logger } from "./logger";

/**
 * Сообщение владелице в Telegram через мост ПСИ (psy-platform-bridge).
 * Токен бота живет у агента, платформа его не видит: она только передает
 * текст по Unix-сокету, а мост отправляет его в личку владелицы.
 *
 * Возвращает true, если сообщение принято: отправлено или мост его
 * придержал как повтор (429 - такое же сообщение уже ушло недавно).
 * false - мост недоступен или Telegram не принял сообщение.
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
        res.resume();
        const status = res.statusCode ?? 0;
        if (status === 200 || status === 429) {
          resolve(true);
        } else {
          logger.warn({ status }, "Мост не отправил уведомление владелице");
          resolve(false);
        }
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
