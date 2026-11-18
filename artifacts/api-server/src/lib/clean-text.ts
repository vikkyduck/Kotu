import type { RequestHandler } from "express";

/**
 * Очистка того, что вводит человек, до записи в базу.
 *
 * Всё, что приходит в теле запроса (формы сайта, правки текста, инструменты
 * агента - они ходят через тот же API), проходит через cleanRequestBody: из
 * строк убираются HTML-теги, блоки скриптов и стилей целиком, HTML-комментарии
 * и управляющие символы. В базу попадает только обычный текст. Имена и подписи
 * загружаемых файлов (multipart) чистятся в своих маршрутах тем же cleanText.
 *
 * Чего здесь нет и почему:
 * - SQL-слова (SELECT, DROP и т.п.) из текста не вырезаются: это обычные слова,
 *   они встречаются в лекциях и расшифровках. От SQL-инъекций защищает не
 *   вырезание, а параметры запросов: все запросы к базе идут через Drizzle с
 *   параметрами, а lib/sql-safety.test.ts следит, чтобы склеенного SQL не появилось;
 * - пароли и одноразовые ключи (SECRET_FIELDS) не меняются: изменённый пароль
 *   перестал бы подходить, а в базу они попадают только хешем;
 * - сравнения в тексте («x < y», «<<цитата>>») не трогаются: тегом считается
 *   только «<» с именем настоящего HTML-элемента.
 *
 * Показ текста на сайте безопасен и сам по себе: React выводит строки как
 * текст, а не как HTML. Очистка - второй рубеж и гарантия для выгрузок.
 *
 * Все шаги линейные (indexOf и регулярные выражения без вложенных повторов):
 * пять мегабайт текста с незакрытыми тегами не должны вешать сервер.
 */

/** Элементы, содержимое которых удаляется вместе с тегами. */
const BLOCK_TAGS = ["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math"];

/** Имена настоящих HTML-элементов: «<b>» - тег, «x<y и y>z» - текст. */
const HTML_TAGS = new Set(
  (
    "a abbr address applet area article aside audio b base basefont bdi bdo bgsound big blink blockquote body br " +
    "button canvas caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em " +
    "embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i " +
    "iframe image img input ins isindex kbd keygen label legend li link listing main map mark marquee math menu " +
    "menuitem meta meter nav nobr noembed noframes noscript object ol optgroup option output p param picture " +
    "plaintext portal pre progress q rb rp rt rtc ruby s samp script search section select slot small source span " +
    "strike strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track tt " +
    "u ul var video wbr xmp animate animatemotion animatetransform foreignobject set use"
  ).split(" "),
);

const BLOCK_OPEN = new RegExp(`<(${BLOCK_TAGS.join("|")})\\b[^<>]*>`, "gi");
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)(?:\s[^<>]*)?\/?>/g;
/** <!DOCTYPE …>, <![CDATA[ …, <?xml …?> */
const DECLARATION = /<![A-Za-z[][^<>]*>|<\?[A-Za-z][^<>]*\?>/g;
// Управляющие символы, кроме перевода строки и табуляции; NUL Postgres не принимает вовсе.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** <script>…</script> и подобные - вместе с содержимым; незакрытый - только сам тег. */
function removeBlocks(text: string): string {
  let out = "";
  let pos = 0;
  // Элемент, у которого дальше по тексту нет закрытия: у следующих таких же
  // его тоже нет, искать заново - квадратичная работа на «<script>» × 100 000.
  const unclosed = new Set<string>();
  BLOCK_OPEN.lastIndex = 0;
  for (let m = BLOCK_OPEN.exec(text); m !== null; m = BLOCK_OPEN.exec(text)) {
    const tag = m[1].toLowerCase();
    const afterOpen = m.index + m[0].length;
    let found: RegExpExecArray | null = null;
    if (!unclosed.has(tag)) {
      const close = new RegExp(`</${tag}`, "gi");
      close.lastIndex = afterOpen;
      found = close.exec(text);
      if (!found) unclosed.add(tag);
    }
    let end = afterOpen;
    if (found) {
      const gt = text.indexOf(">", found.index);
      end = gt === -1 ? text.length : gt + 1;
    }
    out += text.slice(pos, m.index);
    pos = end;
    BLOCK_OPEN.lastIndex = end;
  }
  return out + text.slice(pos);
}

/** <!-- … --> целиком; от незакрытого остаётся текст без самой метки. */
function removeComments(text: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<!--", pos);
    if (start === -1) return out + text.slice(pos);
    out += text.slice(pos, start);
    const end = text.indexOf("-->", start + 4);
    // Дальше закрытий нет вовсе: убрать оставшиеся метки и закончить.
    if (end === -1) return out + text.slice(start).split("<!--").join("");
    pos = end + 3;
  }
}

/** Строка, которую ввёл человек, - в безопасный обычный текст. */
export function cleanText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  // Повторяем, пока что-то меняется: «<scr<script>…</script>ipt>» после
  // одного прохода собрался бы в новый тег.
  for (let pass = 0; pass < 5; pass++) {
    const next = removeComments(removeBlocks(text))
      .replace(DECLARATION, "")
      .replace(TAG, (tag, name: string) => (HTML_TAGS.has(name.toLowerCase()) ? "" : tag));
    if (next === text) break;
    text = next;
  }
  return text.replace(CONTROL, "");
}

/**
 * Поля входа и смены пароля (routes/auth.ts) - в верхнем уровне тела запроса.
 * Не меняются: в базу попадают только хешем, а изменённые перестали бы подходить.
 */
export const SECRET_FIELDS: ReadonlySet<string> = new Set(["password", "current", "next", "token"]);

/** Все строки на любой глубине. */
export function cleanDeep<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => cleanDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cleanDeep(v);
    return out as T;
  }
  return value;
}

/** Тело запроса: всё, кроме паролей и ключей верхнего уровня. */
export function cleanBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = SECRET_FIELDS.has(k) && typeof v === "string" ? v : cleanDeep(v);
  }
  return out;
}

/** Для app.ts: после разбора JSON и форм - до любого маршрута. */
export const cleanRequestBody: RequestHandler = (req, _res, next) => {
  const body: unknown = req.body;
  if (Array.isArray(body)) req.body = cleanDeep(body);
  else if (body !== null && typeof body === "object") req.body = cleanBody(body as Record<string, unknown>);
  next();
};
