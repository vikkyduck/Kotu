import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Репозиторий публичный: в нём не должно быть ни секретов, ни персональных
 * данных, ни адресов серверов. Все секреты живут только в /opt/kotu/.env на
 * сервере, адрес сервера - в ops/server.local (в git не попадает), почты и
 * имена пользователей - только в базе.
 *
 * Тест читает все файлы под git и падает, если находит ключ, пароль в строке
 * подключения, внешний IP-адрес или настоящую почту. deploy.sh гоняет тесты
 * перед выкладкой, поэтому такая находка останавливает выкладку.
 */

function repoFiles(): { root: string; files: string[] } | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const files = execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((f) => f !== "" && !/\.(woff2?|ttf|otf|png|jpe?g|gif|ico|pdf|webp)$/i.test(f) && f !== "pnpm-lock.yaml");
    return { root, files };
  } catch {
    return null;
  }
}

const repo = repoFiles();

/** Не часть кода из base64 (встроенные картинки и шрифты): слева и справа - не символы base64. */
const B64 = "A-Za-z0-9+/=";
const SECRETS: [string, RegExp][] = [
  ["ключ OpenAI или Anthropic", /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ["ключ AWS", /AKIA[0-9A-Z]{16}/],
  ["токен GitHub", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["ключ Google", /AIza[0-9A-Za-z_-]{30,}/],
  ["ключ Perplexity", /pplx-[A-Za-z0-9]{20,}/],
  ["приватный ключ", /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ["токен бота Telegram", /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ["ключ Yandex Cloud", new RegExp(`(?<![${B64}])(?:YC[A-Za-z0-9_-]{38}|AQVN[A-Za-z0-9_-]{30,})(?![${B64}])`)],
  // Заглушки (ПАРОЛЬ, <пароль>) и шаблоны sed/regex, которые вынимают пароль из .env, - не пароль.
  ["пароль в строке подключения к базе", /(?:postgres(?:ql)?|mysql|redis|mongodb):\/\/[^:@/\s]+:(?!ПАРОЛЬ@|<|\\\(|\[)[^@/\s]+@/],
];

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
function isPublicIp(a: number, b: number, c: number): boolean {
  if (a === 127 || a === 0 || a === 10 || a === 255) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  // Диапазоны для документации и тестов (RFC 5737).
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Разрешённые адреса: примеры, тестовые домены и технические адреса. */
const EMAIL_OK = /@(?:[a-z0-9.-]+\.)?(?:example\.(?:ru|com|org)|[a-z0-9-]+\.test|[a-z0-9.-]+\.invalid|simulator\.pstbx\.ru)$|^git@github\.com$|^noreply@anthropic\.com$/i;

function findings(): string[] {
  const out: string[] = [];
  for (const file of repo!.files) {
    let text: string;
    try {
      text = readFileSync(path.join(repo!.root, file), "utf8");
    } catch {
      continue;
    }
    if (file.endsWith("repo-hygiene.test.ts")) continue;
    text.split("\n").forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      for (const [kind, rx] of SECRETS) if (rx.test(line)) out.push(`${where}: ${kind}`);
      for (const m of line.matchAll(IPV4)) {
        const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
        if ([a, b, c, d].every((n) => n <= 255) && isPublicIp(a, b, c)) out.push(`${where}: IP-адрес ${m[0]}`);
      }
      for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) out.push(`${where}: почта ${m[0]}`);
    });
  }
  return out;
}

describe.skipIf(repo === null)("в репозитории нет секретов, персональных данных и адресов серверов", () => {
  test("ни одной находки", () => {
    expect(findings()).toEqual([]);
  });

  test("файлы с секретами закрыты от git", () => {
    const ignored = (p: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", p], { cwd: repo!.root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored(".env")).toBe(true);
    expect(ignored("artifacts/api-server/.env")).toBe(true);
    expect(ignored("ops/server.local")).toBe(true);
    expect(ignored(".env.example")).toBe(false);
  });
});
