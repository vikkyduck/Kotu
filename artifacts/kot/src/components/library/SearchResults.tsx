import { Icon } from '@/lib/icons';
import { KIND_ICON, KIND_LABEL, type Hit, type ItemActions, type ItemKind } from '@/lib/library-items';

/**
 * Что нашлось по смыслу. Показываем не список названий, а сами найденные
 * места с указанием главы: автору важно увидеть формулировку, а уже потом
 * решать, открыть материал или сразу сделать из него лекцию.
 */
interface Props {
  hits: Hit[] | null;
  searching: boolean;
  act: ItemActions;
}

export function SearchResults({ hits, searching, act }: Props) {
  return (
    <div className="hits">
      {searching && hits === null && <p className="doc-meta">Ищу…</p>}
      {hits !== null && hits.length === 0 && !searching && (
        <p className="doc-meta">Ничего не нашла. Попробуйте другими словами.</p>
      )}

      {(hits ?? []).map((h) => {
        const kind = (['lecture', 'deck', 'transcript'].includes(h.kind) ? h.kind : 'book') as ItemKind;
        return (
          <div key={h.documentId} className="panel hit">
            <div className="hit-head">
              <span className="doc-ico"><Icon name={KIND_ICON[kind]} /></span>
              <div className="doc-body">
                <b className="doc-title">{h.title}</b>
                <span className="doc-meta">{KIND_LABEL[kind]}</span>
              </div>
            </div>

            {h.quotes.map((q, j) => (
              <p key={j} className="hit-quote">
                {q.heading && <span className="hit-where">{q.heading}: </span>}
                {q.text}
              </p>
            ))}

            <div className="pills">
              <button
                className="pill-opt"
                onClick={() =>
                  // У лекции берём саму лекцию: в ней главы целиком, а не
                  // разрезанный на фрагменты поисковый текст.
                  h.lectureId
                    ? act.newDeck({ sourceKind: 'lecture', sourceId: h.lectureId })
                    : act.newDeck({ sourceKind: 'document', sourceId: h.documentId })
                }
              >
                собрать презентацию
              </button>
              <button className="pill-opt" onClick={() => act.newLecture({ documentIds: [h.documentId] })}>
                написать лекцию на основе
              </button>
              {h.transcriptionId && (
                <button className="pill-opt" onClick={() => act.openTranscription(h.transcriptionId!)}>
                  открыть запись
                </button>
              )}
              {h.lectureId && (
                <button className="pill-opt" onClick={() => act.openLecture(h.lectureId!)}>
                  открыть лекцию
                </button>
              )}
              {h.deckId && (
                <button className="pill-opt" onClick={() => act.openDeck(h.deckId!)}>
                  открыть презентацию
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
