/**
 * Стилевой пакет «Архивный сон» (брендбук Psy3107) в базу.
 *
 * Стиль живёт в данных, а не в коде: автор меняет вкус чаще, чем мы выкатываем
 * приложение. Источник истины — `brand/Psy3107_Presentation_Prompt_Pack.txt`,
 * разделы 2, 3, 5, 7 и 8; здесь он просто перенесён в поля таблицы.
 *
 * Запуск (через ssh-туннель к проду, как миграции):
 *   DATABASE_URL=postgres://kotu:<пароль>@localhost:15432/kotu \
 *     pnpm --filter @workspace/scripts exec tsx ./src/seed-style-pack.ts
 *
 * Повторный запуск обновляет существующий пакет, а не плодит копии.
 */
import { eq } from "drizzle-orm";
import { db, stylePacksTable, type StyleRules, type Typography } from "@workspace/db";
import { BRAND_PALETTE } from "@workspace/db/slides";

const NAME = "Psy3107 · Архивный сон";

/**
 * Мастер-промпт добавляется ПОСЛЕ сюжета: сюжет отвечает за смысл, этот хвост —
 * за технику, палитру и композицию. Меняется только сюжет (брендбук, с. 13).
 * Плейсхолдеры {{...}} подставляет иллюстратор.
 */
const PROMPT_SUFFIX = `visualized as a plate from an imaginary late-19th-century psychoanalytic atlas. Vintage academic copper etching and surrealist archival collage on aged textured paper. Fine hand-drawn lines, dense cross-hatching, aquatint shadows, charcoal and ink details, restrained watercolor washes. Anatomical precision gradually transforms into {{SECOND_METAPHOR}}. Layered double exposure, carefully controlled fragmentation, convincing historical printmaking materiality.

Muted museum palette: sepia, deep indigo, burnt umber and charcoal gray, with one tiny muted carmine OR dull-gold accent — never both. Intellectual, contemplative, sophisticated, dreamlike and slightly melancholic, but never frightening. A feeling of psychological depth and historical archive. Meticulously crafted, refined, tactile, high detail.

Presentation composition, 16:9. Place the main visual mass {{IMAGE_SIDE}}. Preserve at least 40% quiet low-detail aged paper on the {{SAFE_SIDE}} as a safe area for slide typography. No lettering inside the image.`;

const NEGATIVE = `cartoon, anime, manga, 3d render, CGI, cheerful, cute, childlike, bright colors, saturated colors, neon, corporate Memphis art, flat vector illustration, simplistic, photorealism, glossy surfaces, plastic, stock photography, smiling consultant, motivational poster, low resolution, blurry, text, letters, typography, logo, watermark, gore, horror, occult symbols, demonic imagery, jump scare, cracked face used as horror, gears inside the brain, glowing eye, steampunk cliché, fantasy portal, arches, archways, cathedral arches, repeating ornamental frames, excessive gold, excessive red, multiple competing metaphors, cluttered composition`;

// Гарнитура одна — Manrope: ею набирают слайды все три движка (PDF, PPTX,
// предпросмотр). Кегли живут в общей таблице lib/db/src/slides.ts.
const TYPOGRAPHY: Typography = { display: "Manrope", body: "Manrope" };

const RULES: StyleRules = {
  // Три реальности брендбука (с. 5). Соединять можно максимум две.
  metaphorFamilies: ["anatomy", "archive", "dream"],
  maxMetaphorsPerImage: 2,
};

async function main(): Promise<void> {
  const [existing] = await db
    .select()
    .from(stylePacksTable)
    .where(eq(stylePacksTable.name, NAME))
    .limit(1);

  const values = {
    name: NAME,
    promptSuffix: PROMPT_SUFFIX,
    negative: NEGATIVE,
    palette: { ...BRAND_PALETTE },
    typography: TYPOGRAPHY,
    rules: RULES,
  };

  if (existing) {
    await db.update(stylePacksTable).set(values).where(eq(stylePacksTable.id, existing.id));
    console.log(`Обновлён стилевой пакет #${existing.id} «${NAME}»`);
  } else {
    const [created] = await db.insert(stylePacksTable).values(values).returning();
    console.log(`Создан стилевой пакет #${created?.id} «${NAME}»`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
