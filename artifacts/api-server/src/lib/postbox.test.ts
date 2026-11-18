import { describe, expect, test, vi } from "vitest";
import { POSTBOX_URL, fromHeader, sendViaPostbox, signV4 } from "./postbox";

/**
 * Подпись запросов к Postbox (AWS Signature V4) и сам запрос. Сеть не нужна:
 * fetch подменяется.
 */

describe("подпись AWS Signature V4", () => {
  test("совпадает с примером из документации AWS (IAM ListUsers)", () => {
    // Пример из руководства AWS по SigV4: известные ключ, время и итоговая подпись.
    const headers = signV4({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      key: { keyId: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      region: "us-east-1",
      service: "iam",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers["host"]).toBe("iam.amazonaws.com");
  });

  test("другое тело - другая подпись", () => {
    const base = {
      method: "POST",
      url: POSTBOX_URL,
      headers: { "content-type": "application/json" },
      key: { keyId: "id", secret: "secret" },
      region: "ru-central1",
      service: "ses",
      now: new Date("2026-11-18T19:05:07Z"),
    };
    expect(signV4({ ...base, body: "{}" })["authorization"]).not.toBe(signV4({ ...base, body: "{ }" })["authorization"]);
  });
});

describe("отправитель", () => {
  test("русское имя кодируется по RFC 2047", () => {
    expect(fromHeader("Psy Библиотека", "noreply@example.ru")).toBe(
      `=?UTF-8?B?${Buffer.from("Psy Библиотека").toString("base64")}?= <noreply@example.ru>`,
    );
  });

  test("латинское имя - в кавычках", () => {
    expect(fromHeader('Kot "Lib"', "a@b.ru")).toBe('"Kot \\"Lib\\"" <a@b.ru>');
  });
});

describe("отправка", () => {
  const key = { keyId: "AJE-test-id", secret: "never-in-logs" };
  const msg = {
    fromName: "Psy Библиотека",
    fromAddress: "noreply@example.ru",
    to: "user@example.com",
    subject: "Тема",
    text: "Текст",
    html: "<p>Текст</p>",
  };

  test("подписанный POST в Postbox с письмом SES v2", async () => {
    const fetchMock = vi.fn(async () => new Response('{"MessageId":"m-1"}', { status: 200 }));
    const id = await sendViaPostbox(key, msg, new Date("2026-11-18T19:05:07Z"), fetchMock as unknown as typeof fetch);
    expect(id).toBe("m-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://postbox.cloud.yandex.net/v2/email/outbound-emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["host"]).toBeUndefined();
    expect(headers["x-amz-date"]).toBe("20261118T190507Z");
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AJE-test-id\/20261118\/ru-central1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["authorization"]).not.toContain("never-in-logs");

    const body = JSON.parse(String(init.body));
    expect(body.Destination).toEqual({ ToAddresses: ["user@example.com"] });
    expect(body.FromEmailAddress).toMatch(/^=\?UTF-8\?B\?.+\?= <hello@vi-utkina\.ru>$/);
    expect(body.Content.Simple.Subject).toEqual({ Data: "Тема", Charset: "UTF-8" });
    expect(body.Content.Simple.Body.Text.Data).toBe("Текст");
    expect(body.Content.Simple.Body.Html.Data).toBe("<p>Текст</p>");
  });

  test("отказ Postbox - ошибка с кодом и текстом ответа, без секрета", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"Domain is not verified"}', { status: 400 }));
    const err = await sendViaPostbox(key, msg, new Date(), fetchMock as unknown as typeof fetch).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).toContain("Domain is not verified");
    expect((err as Error).message).not.toContain("never-in-logs");
  });
});
