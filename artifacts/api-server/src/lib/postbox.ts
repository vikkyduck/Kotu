import { createHash, createHmac } from "node:crypto";

/**
 * Отправка письма через Yandex Cloud Postbox по HTTPS.
 *
 * Зачем не SMTP: сервер платформы стоит в DigitalOcean, а там исходящие
 * почтовые порты (25, 465, 587) закрыты. HTTPS открыт.
 *
 * API Postbox совместим с Amazon SES v2: запрос подписывается AWS Signature
 * Version 4 статическим ключом сервисного аккаунта с ролью postbox.sender.
 * Подпись считаем сами на node:crypto: ради одного запроса не тянем AWS SDK.
 * Документация: https://yandex.cloud/ru/docs/postbox/operations/send-email
 */

export const POSTBOX_URL = "https://postbox.cloud.yandex.net/v2/email/outbound-emails";
const REGION = "ru-central1";
const SERVICE = "ses";
const TIMEOUT_MS = 20_000;

export interface PostboxKey {
  /** Идентификатор статического ключа сервисного аккаунта. */
  keyId: string;
  /** Секретная часть статического ключа. */
  secret: string;
}

const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** Кодирование по RFC 3986, как требует SigV4: encodeURIComponent оставляет !'()* как есть. */
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** 2026-11-18T19:05:07.123Z -> 20261118T190507Z */
function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Подпись AWS Signature Version 4. Подписываются все переданные заголовки;
 * host и x-amz-date добавляются сами. Возвращает заголовки для запроса вместе
 * с Authorization (host в них есть: fetch всё равно поставит тот же).
 */
export function signV4(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  key: PostboxKey;
  region: string;
  service: string;
  now: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const stamp = amzDate(input.now);
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  headers["host"] = url.host;
  headers["x-amz-date"] = stamp;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname || "/",
    canonicalQuery(url),
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.key.secret}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.key.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Имя отправителя в заголовке From. Не-ASCII имя кодируется по RFC 2047,
 * иначе SES-совместимый API отклоняет адрес.
 */
export function fromHeader(name: string, address: string): string {
  if (name === "") return address;
  const encoded = /^[\x20-\x7e]*$/.test(name)
    ? `"${name.replace(/["\\]/g, "\\$&")}"`
    : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  return `${encoded} <${address}>`;
}

export interface PostboxMessage {
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Отправляет одно письмо, возвращает MessageId от Postbox. */
export async function sendViaPostbox(
  key: PostboxKey,
  msg: PostboxMessage,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = JSON.stringify({
    FromEmailAddress: fromHeader(msg.fromName, msg.fromAddress),
    Destination: { ToAddresses: [msg.to] },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: msg.text, Charset: "UTF-8" },
          Html: { Data: msg.html, Charset: "UTF-8" },
        },
      },
    },
  });

  const signed = signV4({
    method: "POST",
    url: POSTBOX_URL,
    headers: { "content-type": "application/json" },
    body,
    key,
    region: REGION,
    service: SERVICE,
    now,
  });
  // Host fetch ставит сам из адреса; передавать его руками нельзя.
  const { host: _host, ...headers } = signed;

  const res = await fetchImpl(POSTBOX_URL, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const reply = await res.text();
  if (!res.ok) {
    // В ответе Postbox только код и описание ошибки, ключей там нет.
    throw new Error(`Postbox ответил ${res.status}: ${reply.slice(0, 300)}`);
  }
  let messageId = "";
  try {
    messageId = String((JSON.parse(reply) as { MessageId?: unknown }).MessageId ?? "");
  } catch {
    // Письмо принято (2xx), просто без разборчивого ответа.
  }
  return messageId;
}
