import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";
import { sendViaPostbox } from "./postbox";

/**
 * Отправка писем. Единственное письмо, которое шлёт платформа, — ссылка для
 * сброса забытого пароля.
 *
 * Основной путь — Yandex Cloud Postbox по HTTPS (lib/postbox.ts): сервер стоит
 * в DigitalOcean, где исходящие почтовые порты закрыты, и SMTP оттуда не
 * работает. Домен отправителя (MAIL_FROM) подтверждён в Postbox записями
 * DKIM. Ключ вводится вслепую скриптом ./set-mail-postbox.sh.
 *
 * SMTP Яндекс 360 остаётся запасным путём для сервера, где почтовые порты
 * открыты: он включается, только если ключа Postbox нет.
 */
const SENDER_NAME = "Psy Библиотека";

function settings() {
  const env = process.env;
  const smtpUser = env["SMTP_USER"] ?? "";
  return {
    postboxKeyId: env["POSTBOX_KEY_ID"] ?? "",
    postboxSecret: env["POSTBOX_SECRET_KEY"] ?? "",
    smtpHost: env["SMTP_HOST"] ?? "smtp.yandex.ru",
    smtpPort: Number(env["SMTP_PORT"] ?? 465),
    smtpUser,
    smtpPass: env["SMTP_PASS"] ?? "",
    from: env["MAIL_FROM"] ?? smtpUser,
  };
}

function postboxConfigured(s = settings()): boolean {
  return s.postboxKeyId !== "" && s.postboxSecret !== "";
}

function smtpConfigured(s = settings()): boolean {
  return s.smtpUser !== "" && s.smtpPass !== "";
}

export function mailConfigured(): boolean {
  const s = settings();
  return s.from !== "" && (postboxConfigured(s) || smtpConfigured(s));
}

let transport: Transporter | null = null;

function getTransport(s: ReturnType<typeof settings>): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpPort === 465,
      auth: { user: s.smtpUser, pass: s.smtpPass },
    });
  }
  return transport;
}

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  const s = settings();
  if (s.from === "") {
    throw new Error("Почта не настроена: нет MAIL_FROM");
  }
  if (postboxConfigured(s)) {
    const messageId = await sendViaPostbox(
      { keyId: s.postboxKeyId, secret: s.postboxSecret },
      { fromName: SENDER_NAME, fromAddress: s.from, to, subject, text, html },
    );
    // В лог — только адрес и идентификатор письма, без содержимого.
    logger.info({ to, messageId, via: "postbox" }, "Письмо отправлено");
    return;
  }
  if (!smtpConfigured(s)) {
    throw new Error("Почта не настроена: нет ключа Postbox (POSTBOX_KEY_ID, POSTBOX_SECRET_KEY) и нет SMTP_USER/SMTP_PASS");
  }
  const info = await getTransport(s).sendMail({
    from: `"${SENDER_NAME}" <${s.from}>`,
    to,
    subject,
    text,
    html,
  });
  logger.info({ to, messageId: info.messageId, via: "smtp" }, "Письмо отправлено");
}

/** Адрес симулятора Postbox: письмо принимается как доставленное и никому не приходит. */
const POSTBOX_SIMULATOR = "success@simulator.pstbx.ru";

/**
 * Проверка почты для самопроверки (lib/self-check.ts): null - письма уходят,
 * иначе - что не так. Postbox проверяется настоящей отправкой на адрес
 * симулятора, SMTP - входом на сервер без отправки.
 */
export async function checkMail(): Promise<string | null> {
  const s = settings();
  if (!mailConfigured()) return "почта не настроена: нет ключа Postbox и нет SMTP";
  try {
    if (postboxConfigured(s)) {
      await sendViaPostbox(
        { keyId: s.postboxKeyId, secret: s.postboxSecret },
        {
          fromName: SENDER_NAME,
          fromAddress: s.from,
          to: POSTBOX_SIMULATOR,
          subject: "Проверка почты платформы",
          text: "Самопроверка платформы.",
          html: "<p>Самопроверка платформы.</p>",
        },
      );
    } else {
      await getTransport(s).verify();
    }
    return null;
  } catch (err) {
    return `письма не уходят: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Письмо со ссылкой на сброс. Просто, коротко и без лишних обещаний. */
export function resetEmail(name: string, link: string): { subject: string; text: string; html: string } {
  const subject = "Восстановление пароля — Psy Библиотека";
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
