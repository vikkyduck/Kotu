import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

/**
 * Отправка писем через Яндекс (домен withoutwater.ru: SPF и DKIM настроены,
 * поэтому письма не уходят в спам). Единственное письмо, которое шлёт
 * платформа, — ссылка для сброса забытого пароля.
 */
const HOST = process.env["SMTP_HOST"] ?? "smtp.yandex.ru";
const PORT = Number(process.env["SMTP_PORT"] ?? 465);
const USER = process.env["SMTP_USER"] ?? "";
const PASS = process.env["SMTP_PASS"] ?? "";
const FROM = process.env["MAIL_FROM"] ?? USER;

let transport: Transporter | null = null;

export function mailConfigured(): boolean {
  return USER !== "" && PASS !== "";
}

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465,
      auth: { user: USER, pass: PASS },
    });
  }
  return transport;
}

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  if (!mailConfigured()) {
    throw new Error("Почта не настроена: нет SMTP_USER или SMTP_PASS");
  }
  const info = await getTransport().sendMail({
    from: `"Рабочая среда" <${FROM}>`,
    to,
    subject,
    text,
    html,
  });
  // В лог — только адрес и идентификатор письма, без содержимого.
  logger.info({ to, messageId: info.messageId }, "Письмо отправлено");
}

/** Письмо со ссылкой на сброс. Просто, коротко и без лишних обещаний. */
export function resetEmail(name: string, link: string): { subject: string; text: string; html: string } {
  const subject = "Восстановление пароля — Рабочая среда";
  const text = [
    `${name}, здравствуйте.`,
    "",
    "Вы запросили восстановление пароля к рабочей среде.",
    "Откройте ссылку и задайте новый пароль:",
    link,
    "",
    "Ссылка действует один час и сработает только один раз.",
    "Если вы ничего не запрашивали — просто удалите это письмо, пароль останется прежним.",
  ].join("\n");

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#2b2b33;max-width:520px">
  <p>${name}, здравствуйте.</p>
  <p>Вы запросили восстановление пароля к рабочей среде.</p>
  <p style="margin:26px 0">
    <a href="${link}" style="display:inline-block;padding:13px 24px;border-radius:12px;background:#5b50b0;color:#fff;text-decoration:none;font-weight:600">
      Задать новый пароль
    </a>
  </p>
  <p style="color:#6b6b76;font-size:13.5px">
    Ссылка действует один час и сработает только один раз.<br>
    Если вы ничего не запрашивали — просто удалите это письмо, пароль останется прежним.
  </p>
</div>`.trim();

  return { subject, text, html };
}
