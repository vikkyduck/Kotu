import type { RequestHandler } from "express";
import type { User } from "@workspace/db";
import { SESSION_COOKIE, findUserBySession } from "../lib/auth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Закрывает всё, кроме /healthz и /auth/*. В системе лежат расшифровки сеансов —
 * открытых ручек здесь быть не должно.
 *
 * Cookie мёртвой сессии не стираем: запоздалый ответ на запрос со старым
 * токеном стёр бы уже новую cookie, выданную входом или сменой пароля.
 * Мёртвая cookie безвредна — её заменит следующий вход.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  // Файл книги открывают во вкладке — там нужна фраза, а не JSON. fetch шлёт
  // Accept */* и картинки image/*: им по-прежнему JSON.
  const deny = (message: string) => {
    if (req.accepts(["json", "html"]) === "html") {
      res.status(401).type("text/plain; charset=utf-8").send(message);
    } else {
      res.status(401).json({ message });
    }
  };

  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) {
    deny("Нужно войти");
    return;
  }

  const user = await findUserBySession(token);
  if (!user) {
    deny("Сессия истекла — войдите заново");
    return;
  }

  req.user = user;
  next();
};
