/**
 * Связи между работами: типы ответа сервера (api-server/src/lib/relations.ts)
 * и переход к файлу документа. Ссылки на экранах - components/Related.tsx.
 */

/** Работа одной строкой (как WorkRef на сервере). */
export interface WorkRef {
  id: number;
  title: string;
}

/** Материал библиотеки: копия записи открывается экраном записи, книга - файлом. */
export interface MaterialRef extends WorkRef {
  kind: string;
  transcriptionId: number | null;
}

/** Что уже сделано из материала. */
export interface MadeFrom {
  lectures: WorkRef[];
  decks: WorkRef[];
}

/** Из чего собрана презентация. */
export type DeckSource = ({ type: 'lecture' } & WorkRef) | ({ type: 'document' } & MaterialRef);

/** Файл документа - в новой вкладке, как из библиотеки. */
export function openDocumentFile(id: number): void {
  window.open(`/api/documents/${id}/file`, '_blank', 'noopener');
}
