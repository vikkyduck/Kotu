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
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) {
    res.status(401).json({ message: "Нужно войти" });
    return;
  }

  const user = await findUserBySession(token);
  if (!user) {
    res.clearCookie(SESSION_COOKIE);
    res.status(401).json({ message: "Сессия истекла — войдите заново" });
    return;
  }

  req.user = user;
  next();
};
