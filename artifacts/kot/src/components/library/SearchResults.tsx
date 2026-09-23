import { Icon } from '@/lib/icons';
import { KIND_ICON, KIND_LABEL, docKind, type Hit, type ItemActions } from '@/lib/library-items';

/**
 * Что нашлось по смыслу. Показываем не список названий, а сами найденные
 * места с указанием главы: автору важно увидеть формулировку, а уже потом
 * решать, открыть материал или сразу сделать из него лекцию.
 */
interface Props {
  hits: Hit[] | null;
  searching: boolean;
  error: string | null;
  act: ItemActions;
}

export function SearchResults({ hits, searching, error, act }: Props) {
  return (
    <div className="hits">
      {searching && hits === null && <p className="doc-meta">Ищу…</p>}
      {error && !searching && <p className="doc-meta bad">{error}</p>}
      {hits !== null && hits.length === 0 && !searching && (
        <p className="doc-meta">Ничего не нашла. Попробуйте другими словами.</p>
      )}

      {(hits ?? []).map((h) => {
        const kind = docKind(h.kind);
        return (
          <div key={h.documentId} className="panel hit">
            <div className="hit-head">
              <span className="doc-ico"><Icon name={KIND_ICON[kind]} /></span>
              <div className="doc-body">
                {/* Книгу открывают файлом — как с карточки; у своих работ для этого кнопки ниже. */}
                {h.lectureId || h.deckId || h.transcriptionId ? (
                  <b className="doc-title">{h.title}</b>
                ) : (
                  <b
                    className="doc-title doc-link"
                    role="button"
                    tabIndex={0}
                    onClick={() => act.openFile(`/api/documents/${h.documentId}/file`)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      act.openFile(`/api/documents/${h.documentId}/file`);
                    }}
                  >
                    {h.title}
                  </b>
                )}
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
              {/* Презентацию из презентации не собирают — как и на карточке. */}
              {!h.deckId && (
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
              )}
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
