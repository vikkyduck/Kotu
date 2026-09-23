import { logger } from "./logger";

/**
 * Поставщик ответил ошибкой: тело — в журнал, наружу — только кто и код.
 * Текст ошибки доезжает до карточек (decks.error, lectures.error,
 * documents.error), и сырой JSON поставщика там не нужен.
 */
export async function failHttp(res: Response, who: string): Promise<never> {
  const body = await res.text().catch(() => "");
  logger.error({ who, status: res.status, body: body.slice(0, 300) }, "Поставщик ответил ошибкой");
  throw new Error(`${who}: ошибка ${res.status}`);
}
