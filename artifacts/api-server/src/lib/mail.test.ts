import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Какой путь выбирает почта: Postbox, если есть его ключ, иначе SMTP.
 * Postbox и nodemailer подменены, сеть не нужна.
 */

const postbox = vi.hoisted(() => ({ sendViaPostbox: vi.fn(async () => "pb-1") }));
const smtp = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({ messageId: "smtp-1" })) }));
vi.mock("./postbox", () => postbox);
vi.mock("nodemailer", () => ({ default: { createTransport: () => smtp } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));

import { checkMail, mailConfigured, sendMail } from "./mail";

afterEach(() => {
  vi.unstubAllEnvs();
  postbox.sendViaPostbox.mockClear();
  smtp.sendMail.mockClear();
});

function env(vars: Record<string, string>) {
  for (const name of ["POSTBOX_KEY_ID", "POSTBOX_SECRET_KEY", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) {
    vi.stubEnv(name, vars[name] ?? "");
  }
}

describe("выбор пути", () => {
  test("есть ключ Postbox - письмо уходит через Postbox, SMTP не трогается", async () => {
    env({ POSTBOX_KEY_ID: "id", POSTBOX_SECRET_KEY: "secret", SMTP_USER: "noreply@example.ru", SMTP_PASS: "p", MAIL_FROM: "noreply@example.ru" });
    expect(mailConfigured()).toBe(true);
    await sendMail("user@example.com", "Тема", "Текст", "<p>Текст</p>");
    expect(postbox.sendViaPostbox).toHaveBeenCalledTimes(1);
    expect(postbox.sendViaPostbox).toHaveBeenCalledWith(
      { keyId: "id", secret: "secret" },
      expect.objectContaining({ fromAddress: "noreply@example.ru", to: "user@example.com" }),
    );
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  test("ключа Postbox нет - работает прежний SMTP", async () => {
    env({ SMTP_USER: "noreply@example.ru", SMTP_PASS: "p", MAIL_FROM: "noreply@example.ru" });
    expect(mailConfigured()).toBe(true);
    await sendMail("user@example.com", "Тема", "Текст", "<p>Текст</p>");
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(postbox.sendViaPostbox).not.toHaveBeenCalled();
  });

  test("только Postbox без MAIL_FROM - почта не настроена", () => {
    env({ POSTBOX_KEY_ID: "id", POSTBOX_SECRET_KEY: "secret" });
    expect(mailConfigured()).toBe(false);
  });

  test("ничего нет - почта не настроена, отправка - понятная ошибка", async () => {
    env({ MAIL_FROM: "noreply@example.ru" });
    expect(mailConfigured()).toBe(false);
    await expect(sendMail("user@example.com", "Т", "Т", "Т")).rejects.toThrow("POSTBOX_KEY_ID");
  });
});

describe("проверка почты для самопроверки", () => {
  test("Postbox - настоящая отправка на адрес симулятора", async () => {
    env({ POSTBOX_KEY_ID: "id", POSTBOX_SECRET_KEY: "secret", MAIL_FROM: "noreply@example.ru" });
    expect(await checkMail()).toBeNull();
    expect(postbox.sendViaPostbox).toHaveBeenCalledWith(
      { keyId: "id", secret: "secret" },
      expect.objectContaining({ to: "success@simulator.pstbx.ru", fromAddress: "noreply@example.ru" }),
    );
  });

  test("Postbox отказал - понятная проблема", async () => {
    env({ POSTBOX_KEY_ID: "id", POSTBOX_SECRET_KEY: "secret", MAIL_FROM: "noreply@example.ru" });
    postbox.sendViaPostbox.mockRejectedValueOnce(new Error("Postbox ответил 403: Forbidden"));
    expect(await checkMail()).toBe("письма не уходят: Postbox ответил 403: Forbidden");
  });

  test("почта не настроена - так и говорим, ничего не отправляем", async () => {
    env({ MAIL_FROM: "noreply@example.ru" });
    expect(await checkMail()).toContain("не настроена");
    expect(postbox.sendViaPostbox).not.toHaveBeenCalled();
  });
});
