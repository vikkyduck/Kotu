import { test, describe, expect, vi, beforeEach, afterEach } from "vitest";

// lib/auth тянет @workspace/db, а тот без DATABASE_URL падает при импорте.
// Лимитерам база не нужна — подменяем модуль пустышкой.
vi.mock("@workspace/db", () => ({ db: {}, usersTable: {}, sessionsTable: {} }));

import {
  createRateLimiter,
  tooManyAttempts,
  registerFailedAttempt,
  clearAttempts,
  allowForgotRequest,
  forgotLimiterSizes,
  MAX_EMAIL_LENGTH,
  clientKey,
} from "./auth";

const MIN = 60 * 1000;

/**
 * Счётчики — синглтоны модуля и живут между тестами, поэтому у каждого теста
 * свои адреса и почты: так тесты не зависят от порядка запуска.
 */
beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-23T10:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("createRateLimiter", () => {
  test("пускает до лимита и отказывает после", () => {
    const l = createRateLimiter({ limit: 3, windowMs: MIN });
    for (let i = 0; i < 3; i++) {
      expect(l.blocked("a")).toBe(false);
      l.hit("a");
    }
    expect(l.blocked("a")).toBe(true);
    expect(l.blocked("b")).toBe(false);
  });

  test("окно истекает — ключ снова свободен", () => {
    const l = createRateLimiter({ limit: 1, windowMs: MIN });
    l.hit("a");
    expect(l.blocked("a")).toBe(true);
    vi.advanceTimersByTime(MIN - 1);
    expect(l.blocked("a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(l.blocked("a")).toBe(false);
  });

  test("протухшие записи вычищаются, Map не растёт бесконечно", () => {
    const l = createRateLimiter({ limit: 5, windowMs: MIN });
    for (let i = 0; i < 100; i++) l.hit(`old-${i}`);
    expect(l.size()).toBe(100);
    vi.advanceTimersByTime(MIN);
    l.hit("fresh");
    expect(l.size()).toBe(1);
  });

  test("потолок числа ключей внутри окна: старые выкидываются первыми", () => {
    const l = createRateLimiter({ limit: 1, windowMs: MIN, maxKeys: 10 });
    for (let i = 0; i < 25; i++) l.hit(`k-${i}`);
    expect(l.size()).toBe(10);
    expect(l.blocked("k-24")).toBe(true);
    expect(l.blocked("k-0")).toBe(false);
  });

  test("reset снимает блокировку", () => {
    const l = createRateLimiter({ limit: 1, windowMs: MIN });
    l.hit("a");
    l.reset("a");
    expect(l.blocked("a")).toBe(false);
  });
});

describe("clientKey", () => {
  test("IPv6 сводится к /64: смена адреса внутри подсети ничего не даёт", () => {
    const keys = new Set<string>();
    for (let i = 1; i <= 0xffff; i += 257) keys.add(clientKey(`2001:db8::${i.toString(16)}`));
    keys.add(clientKey("2001:0DB8:0000:0000:ffff:ffff:ffff:ffff"));
    keys.add(clientKey("2001:db8::1%eth0"));
    expect([...keys]).toEqual(["2001:db8:0:0::/64"]);
    expect(clientKey("2a03:6f00:1:2:aaaa:bbbb:cccc:dddd")).toBe("2a03:6f00:1:2::/64");
    expect(clientKey("2001:db8:0:1::1")).not.toBe(clientKey("2001:db8::1"));
  });

  test("IPv4 внутри IPv6 — тот же клиент, что и обычный IPv4", () => {
    expect(clientKey("::ffff:203.0.113.1")).toBe("203.0.113.1");
    expect(clientKey("::FFFF:cb00:7101")).toBe("203.0.113.1");
    expect(clientKey("203.0.113.1")).toBe("203.0.113.1");
    // Встроенный IPv4 без ::ffff: — это уже не IPv4-клиент, а обычная IPv6-сеть.
    expect(clientKey("64:ff9b::203.0.113.1")).toBe("64:ff9b:0:0::/64");
  });

  test("мусор и пустота складываются в одну корзину", () => {
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
    expect(clientKey("not-an-ip")).toBe("unknown");
  });
});

describe("неудачные входы", () => {
  test("10 неудач с адреса запирают его на 15 минут, соседние адреса свободны", () => {
    for (let i = 0; i < 10; i++) registerFailedAttempt("203.0.113.1");
    expect(tooManyAttempts("203.0.113.1")).toBe(true);
    expect(tooManyAttempts("203.0.113.2")).toBe(false);
    vi.advanceTimersByTime(15 * MIN);
    expect(tooManyAttempts("203.0.113.1")).toBe(false);
  });

  test("перебор с разных адресов одной IPv6-подсети запирает всю подсеть", () => {
    for (let i = 1; i <= 10; i++) registerFailedAttempt(`2001:db8:aa::${i}`);
    expect(tooManyAttempts("2001:db8:aa::beef")).toBe(true);
    expect(tooManyAttempts("2001:db8:aa:1::1")).toBe(false);
  });

  test("успешный вход обнуляет счётчик", () => {
    for (let i = 0; i < 9; i++) registerFailedAttempt("203.0.113.3");
    clearAttempts("203.0.113.3");
    registerFailedAttempt("203.0.113.3");
    expect(tooManyAttempts("203.0.113.3")).toBe(false);
  });
});

describe("забыли пароль", () => {
  test("не трогает счётчик входа: владелица может войти после шквала сбросов", () => {
    const ip = "198.51.100.1";
    for (let i = 0; i < 20; i++) allowForgotRequest(ip, `owner-${i}@example.com`);
    expect(tooManyAttempts(ip)).toBe(false);
  });

  test("по адресу — 5 в час", () => {
    const ip = "198.51.100.2";
    for (let i = 0; i < 5; i++) expect(allowForgotRequest(ip, `a${i}@ip2.test`)).toBe(true);
    expect(allowForgotRequest(ip, "another@ip2.test")).toBe(false);
    vi.advanceTimersByTime(60 * MIN);
    expect(allowForgotRequest(ip, "another@ip2.test")).toBe(true);
  });

  test("по адресу — ротация IPv6 внутри /64 не обходит лимит", () => {
    for (let i = 1; i <= 5; i++) expect(allowForgotRequest(`2001:db8:bb::${i}`, "")).toBe(true);
    expect(allowForgotRequest("2001:db8:bb::ffff", "")).toBe(false);
  });

  test("по почте — 3 в час, даже с разных адресов", () => {
    const email = "victim@mail.test";
    for (let i = 0; i < 3; i++) expect(allowForgotRequest(`192.0.2.${i}`, email)).toBe(true);
    expect(allowForgotRequest("192.0.2.99", email)).toBe(false);
    // Другая почта с того же свежего адреса проходит.
    expect(allowForgotRequest("192.0.2.100", "other@mail.test")).toBe(true);
    vi.advanceTimersByTime(60 * MIN);
    expect(allowForgotRequest("192.0.2.99", email)).toBe(true);
  });

  test("отказ по адресу не расходует лимит почты", () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < 5; i++) allowForgotRequest(ip, `x${i}@ip3.test`);
    for (let i = 0; i < 10; i++) expect(allowForgotRequest(ip, "kept@ip3.test")).toBe(false);
    expect(allowForgotRequest("198.51.100.4", "kept@ip3.test")).toBe(true);
  });

  test("почта в счётчике — хэш фиксированной длины, а не присланная строка", () => {
    const huge = "a".repeat(240) + "@long.test";
    const before = forgotLimiterSizes().byEmail;
    expect(allowForgotRequest("198.51.100.6", huge)).toBe(true);
    expect(forgotLimiterSizes().byEmail).toBe(before + 1);
    // Одна и та же почта даёт один ключ: лимит 3 в час продолжает работать.
    expect(allowForgotRequest("198.51.100.7", huge)).toBe(true);
    expect(allowForgotRequest("198.51.100.8", huge)).toBe(true);
    expect(allowForgotRequest("198.51.100.9", huge)).toBe(false);
    expect(forgotLimiterSizes().byEmail).toBe(before + 1);
  });

  test("почта длиннее 254 символов не попадает в счётчик почты, но расходует лимит адреса", () => {
    const ip = "198.51.100.10";
    const huge = "a".repeat(10_000) + "@long.test";
    const before = forgotLimiterSizes().byEmail;
    for (let i = 0; i < 5; i++) expect(allowForgotRequest(ip, `${i}${huge}`)).toBe(true);
    expect(forgotLimiterSizes().byEmail).toBe(before);
    expect(allowForgotRequest(ip, huge)).toBe(false);
    // Граница: ровно 254 символа — ещё настоящая почта и считается.
    const edge = "b".repeat(MAX_EMAIL_LENGTH - "@edge.test".length) + "@edge.test";
    expect(allowForgotRequest("198.51.100.11", edge)).toBe(true);
    expect(forgotLimiterSizes().byEmail).toBe(before + 1);
  });

  test("пустая почта расходует только лимит адреса", () => {
    const ip = "198.51.100.5";
    for (let i = 0; i < 5; i++) expect(allowForgotRequest(ip, "")).toBe(true);
    expect(allowForgotRequest(ip, "")).toBe(false);
  });
});
