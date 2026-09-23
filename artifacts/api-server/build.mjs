import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp, readdir, readFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

// Помни: на сервере нет node_modules, поэтому external = «в проде этого пакета
// не будет». Годится только то, без чего код живёт (require в try/catch).
// Всё прочее бандлится, а чего нет ни в бандле, ни здесь — валит сборку.
export const external = [
  // нативные бинарные модули
  "*.node",
  // pg берёт pg-native в try/catch и без него работает на чистом JS.
  "pg-native",
  // pdfjs (через pdf-parse) берёт canvas только для отрисовки страниц,
  // текст из PDF достаётся без него.
  "@napi-rs/canvas",
  // debug красит логи, если найдёт supports-color; без него — просто без цвета.
  "supports-color",
];

/**
 * Параметры — только точки входа и каталог: смоук-сборка обязана получить
 * ровно те же опции esbuild, копии файлов и проверку, что и прод.
 */
export async function buildAll({
  entryPoints = [path.resolve(artifactDir, "src/index.ts")],
  distDir = path.resolve(artifactDir, "dist"),
} = {}) {
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints,
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external,
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // Шрифты PDF-раздатки едут рядом с бандлом: lib/pdf.ts ищет dist/fonts.
  await cp(path.resolve(artifactDir, "assets/fonts"), path.join(distDir, "fonts"), {
    recursive: true,
  });

  // pdfjs в Node не заводит настоящий воркер, а делает import("./pdf.worker.mjs")
  // относительно себя, то есть рядом с бандлом. Берём файл из того pdfjs-dist,
  // что зависит от pdf-parse: версии API и воркера обязаны совпадать.
  const pdfParseRequire = createRequire(createRequire(import.meta.url).resolve("pdf-parse"));
  await cp(
    pdfParseRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.join(distDir, "pdf.worker.mjs"),
  );

  await checkBundle(distDir);
}

/** Имя пакета из спецификатора: "a/b/c" → "a", "@s/a/b" → "@s/a". */
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isDeclaredExternal(name) {
  return external.some((pattern) =>
    pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name,
  );
}

/**
 * Ищет в собранных файлах require по строке, который в проде не найдёт модуль.
 * esbuild молча оставляет такие вызовы как есть (например, require из
 * createRequire или неразрешённый require в try/catch), и узнаём мы о них
 * только по «Cannot find module» на сервере — так в проде не разобрался ни один PDF.
 */
async function checkBundle(distDir) {
  // require, require2, __require и прочие переименования esbuild,
  // createRequire(...)("x") без промежуточной переменной и import("x"),
  // который esbuild оставляет для внешних пакетов.
  const callRe =
    /(?:\b(?:__require|require\d*|import)|createRequire\([^()]*\))\(\s*(["'`])([^"'`$]+)\1\s*\)/g;
  const problems = [];
  for (const file of await readdir(distDir)) {
    if (!file.endsWith(".mjs")) continue;
    const code = await readFile(path.join(distDir, file), "utf8");
    for (const m of code.matchAll(callRe)) {
      const spec = m[2];
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
      const name = packageName(spec);
      if (spec !== name) {
        problems.push(`${file}: ${m[0]} — подпуть пакета ${name}, в бандле его нет`);
      } else if (!isDeclaredExternal(name)) {
        problems.push(`${file}: ${m[0]} — пакета нет ни в бандле, ни в списке external`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "Сборка остановлена: бандл ищет модули, которых на сервере не будет (там нет node_modules).",
        ...[...new Set(problems)].map((p) => `  - ${p}`),
        "Подключай пакет через import со строкой-литералом (import … from \"x\" или import(\"x\")) —",
        "тогда esbuild заберёт код в бандл. Если пакет действительно необязателен и код переживает",
        "его отсутствие (require в try/catch) — впиши его в external в build.mjs.",
      ].join("\n"),
    );
  }
}

// `node build.mjs` собирает всегда. Смоук (smoke/pdf.mjs) импортирует файл ради
// buildAll и ставит KOTU_BUILD_NO_AUTORUN=1. Сравнение путей здесь было хуже:
// при несовпадении сборка молча не шла, и deploy.sh увёз бы старый dist.
if (!process.env["KOTU_BUILD_NO_AUTORUN"]) {
  buildAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
