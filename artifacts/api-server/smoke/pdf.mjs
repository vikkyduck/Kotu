// Смоук PDF: собирает разбор PDF ТЕМИ ЖЕ опциями, что прод (buildAll из
// build.mjs), в каталог вне репозитория, где нет node_modules, и разбирает
// двухстраничный PDF с кириллицей. Ловит то, чего не видят тесты: в vitest на
// Mac стоит нативный @napi-rs/canvas, а на сервере его нет, и статический
// импорт pdf-parse уронил бы там весь API на старте.
//
// Запуск: pnpm --filter @workspace/api-server run smoke:pdf
// Когда: после обновления pdf-parse / pdfjs-dist и правок build.mjs.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env["KOTU_BUILD_NO_AUTORUN"] = "1";
const { buildAll } = await import("../build.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit");
const FONT = path.join(here, "../assets/fonts/Manrope-Regular.ttf");
const PAGES = ["Работа горя требует времени", "Навязчивое повторение вытесненного"];

const dir = await mkdtemp(path.join(os.tmpdir(), "kotu-pdf-smoke-"));
try {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (existsSync(path.join(d, "node_modules"))) {
      throw new Error(`Над ${dir} есть node_modules (${d}) — смоук ничего бы не доказал`);
    }
  }

  const pdf = path.join(dir, "smoke.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4" });
    const out = createWriteStream(pdf).on("finish", resolve).on("error", reject);
    doc.pipe(out);
    doc.font(FONT).fontSize(14).text(PAGES[0]);
    doc.addPage().font(FONT).fontSize(14).text(PAGES[1]);
    doc.end();
  });

  const dist = path.join(dir, "dist");
  await buildAll({ entryPoints: [path.join(here, "pdf-entry.ts")], distDir: dist });

  // pdfjs без canvas печатает предупреждения в stdout — результат ищем по метке.
  const stdout = execFileSync(process.execPath, [path.join(dist, "pdf-entry.mjs"), pdf], {
    cwd: dir,
    encoding: "utf8",
  });
  const line = stdout.split("\n").find((l) => l.startsWith("SMOKE_RESULT "));
  if (!line) throw new Error(`Нет результата разбора:\n${stdout}`);
  const { text, pages } = JSON.parse(line.slice("SMOKE_RESULT ".length));
  const missing = PAGES.filter((p) => !text.includes(p));
  if (pages !== 2 || missing.length > 0) {
    throw new Error(`Разбор неверный: страниц ${pages}, не найдено: ${missing.join(" | ")}`);
  }
  console.log(`✅ PDF из бандла без node_modules: ${pages} стр., кириллица на месте`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
