import { Fragment } from 'react';
import { useApp } from '@/hooks/use-app';
import { openDocumentFile, type MaterialRef, type WorkRef } from '@/lib/related';

/**
 * Связи между работами одной строкой ссылок: «Материалы: «Запись 1», «Книга»»,
 * «Из лекции: «…»», «Уже сделано: лекция «…», презентация «…»».
 *
 * Сервер отдаёт связи вместе с лекцией, презентацией и записью
 * (api-server/src/lib/relations.ts); здесь одно правило, куда ведёт ссылка,
 * на все три экрана.
 */

interface Link {
  key: string;
  text: string;
  open: () => void;
}

/** Ссылки на материал, лекцию и презентацию - одно правило перехода. */
export function useRelatedLinks() {
  const { openTranscription, openLecture, openDeck } = useApp();
  return {
    material: (m: MaterialRef, prefix = ''): Link => ({
      key: `doc:${m.id}`,
      text: `${prefix}«${m.title}»`,
      open: () => (m.transcriptionId !== null ? openTranscription(m.transcriptionId) : openDocumentFile(m.id)),
    }),
    lecture: (l: WorkRef, prefix = ''): Link => ({
      key: `lecture:${l.id}`,
      text: `${prefix}«${l.title}»`,
      open: () => openLecture(l.id),
    }),
    deck: (d: WorkRef, prefix = ''): Link => ({
      key: `deck:${d.id}`,
      text: `${prefix}«${d.title}»`,
      open: () => openDeck(d.id),
    }),
  };
}

/** «Подпись: ссылка, ссылка». Пусто - ничего не рисуем. */
export function RelatedLine({ label, links }: { label: string; links: Link[] }) {
  if (links.length === 0) return null;
  return (
    <p className="related">
      {label}:{' '}
      {links.map((l, i) => (
        <Fragment key={l.key}>
          {i > 0 && ', '}
          <button type="button" className="inline-link" onClick={l.open}>
            {l.text}
          </button>
        </Fragment>
      ))}
    </p>
  );
}
