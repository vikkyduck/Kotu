import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { useDraft, useUnsavedWarning } from '@/hooks/use-draft';
import { Icon } from '@/lib/icons';
import { send, json } from '@/lib/http';
import { pressable } from '@/lib/deck';
import { KIND_ICON, KIND_LABEL, docKind } from '@/lib/library-items';
import type { DocumentStatus, LectureStatus } from '@workspace/db/schema';

/**
 * Новая презентация: из чего её собрать.
 *
 * Три источника — готовая лекция, материал библиотеки или вставленный текст.
 * Форма сама знает, что показывать, и сама заводит колоду; экрану презентаций
 * остаётся открыть созданное.
 */

interface LectureItem {
  id: number;
  title: string;
  status: LectureStatus;
}

/** Документ библиотеки — тоже законный источник презентации. */
interface DocItem {
  id: number;
  title: string;
  kind: string;
  status: DocumentStatus;
  transcriptionId: number | null;
}

interface StylePackItem {
  id: number;
  name: string;
}

interface Props {
  onCreated: (deckId: number) => void;
}

const LIST_FAIL = 'Не удалось загрузить список';

export function DeckForm({ onCreated }: Props) {
  const { go, toast, deckSeed } = useApp();

  // null — список ещё не пришёл: «пока нет» говорим только о настоящей пустоте.
  const [lectures, setLectures] = useState<LectureItem[] | null>(null);
  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Имена записей: копия расшифровки со скрытыми именами называется
  // нейтрально («Расшифровка от …»), а автору нужно настоящее имя, как в библиотеке.
  const [records, setRecords] = useState<{ id: number; title: string }[]>([]);
  const [packs, setPacks] = useState<StylePackItem[]>([]);

  const [pickedLecture, setPickedLecture] = useState<number | null>(null);
  const [pickedDoc, setPickedDoc] = useState<number | null>(null);
  // Стиль серии: null = «не выбирал», тогда действует первый из списка.
  const [pickedPack, setPickedPack] = useState<number | null>(null);
  // Вставленный текст — черновик: до нажатия кнопки сервер о нём не знает,
  // поэтому он переживает закрытие вкладки сам.
  const [rawText, setRawText, clearRawText] = useDraft('deck-text', true);
  const [busy, setBusy] = useState(false);

  useUnsavedWarning(rawText.trim() !== '');

  const load = useCallback(async () => {
    setLoadError(null);
    const quiet = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const [l, d, t, p] = await Promise.all([
      send('/api/lectures', undefined, LIST_FAIL),
      send('/api/documents', undefined, LIST_FAIL),
      // Без имён записей и стилей форма работает: имя копии и стиль по умолчанию.
      quiet('/api/transcriptions'),
      quiet('/api/style-packs'),
    ]);
    // Не пришло — прежний список остаётся, а вместо «пока нет» видна причина.
    if (l.ok) {
      setLectures(((await l.res.json()) as LectureItem[]).filter((x) => x.status === 'ready'));
    } else setLoadError(l.message);
    // Текст лекции и текст колоды — их поисковые копии: лекция уже стоит
    // отдельным списком выше, а собирать презентацию из презентации незачем.
    if (d.ok) {
      setDocs(
        ((await d.res.json()) as DocItem[]).filter(
          (x) => x.status === 'ready' && x.kind !== 'lecture' && x.kind !== 'deck',
        ),
      );
    } else setLoadError(d.message);
    if (t) setRecords(t);
    if (p) setPacks(p);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Пришли из библиотеки с материалом («сделать презентацию из этого») —
  // источник уже выбран, автору остаётся нажать одну кнопку.
  useEffect(() => {
    if (!deckSeed) return;
    if (deckSeed.sourceKind === 'lecture') {
      setPickedLecture(deckSeed.sourceId);
      setPickedDoc(null);
    } else {
      setPickedDoc(deckSeed.sourceId);
      setPickedLecture(null);
    }
  }, [deckSeed]);

  // Колода соберётся из выбранной лекции или документа — вставленный текст
  // тогда на сервер не уйдёт, и обещать его сохранить нельзя.
  const fromText = pickedLecture === null && pickedDoc === null;

  const create = async () => {
    const raw = rawText.trim();
    if (fromText && raw === '') {
      toast('Выберите лекцию, документ из библиотеки или вставьте текст');
      return;
    }
    setBusy(true);
    try {
      // Явный выбор либо первый из списка; список пуст (сеть моргнула) —
      // поле не шлём, сервер возьмёт первый доступный сам.
      const stylePackId = pickedPack ?? packs[0]?.id;
      const source =
        pickedLecture !== null
          ? { sourceKind: 'lecture', sourceId: pickedLecture }
          : pickedDoc !== null
            ? { sourceKind: 'document', sourceId: pickedDoc }
            : { sourceKind: 'raw', rawText: raw };
      const body = { ...source, ...(stylePackId !== undefined ? { stylePackId } : {}) };
      const r = await send('/api/decks', json('POST', body), 'Не удалось создать презентацию');
      if (!r.ok) {
        toast(r.message);
        return;
      }
      const created = (await r.res.json()) as { id: number };
      // Черновик стираем, только если колода собрана из него: текст, который
      // лежал рядом с выбранной лекцией, сервер так и не получил.
      if (source.sourceKind === 'raw') clearRawText();
      setPickedLecture(null);
      setPickedDoc(null);
      setPickedPack(null);
      onCreated(created.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="screen active" id="s-slides">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> В библиотеку
      </button>

      <h2 className="h2">Собрать презентацию</h2>

      <div className="panel">
        <div className="fieldlbl">Из готовой лекции</div>
        {lectures === null ? (
          loadError && <p className="doc-meta">{loadError}</p>
        ) : lectures.length === 0 ? (
          <p className="doc-meta">Готовых лекций пока нет.</p>
        ) : (
          <div className="resume" style={{ marginBottom: 6 }}>
            {lectures.map((l) => (
              <div
                key={l.id}
                className="r sel-lec"
                aria-pressed={pickedLecture === l.id}
                {...pressable(() => {
                  setPickedDoc(null);
                  setPickedLecture((p) => (p === l.id ? null : l.id));
                })}
              >
                <span className="ri"><Icon name="pen" /></span>
                <span className="rt">
                  <b>{l.title}</b>
                  <span>Лекция готова</span>
                </span>
                {pickedLecture === l.id && (
                  <span className="chev sel-mark"><Icon name="check" /></span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Книга, статья или расшифровка — материал для слайдов не хуже лекции */}
        <div className="fieldlbl">Из библиотеки</div>
        {docs === null ? (
          loadError && <p className="doc-meta">{loadError}</p>
        ) : docs.length === 0 ? (
          <p className="doc-meta">В библиотеке пока нет разобранных документов.</p>
        ) : (
          <div className="resume" style={{ marginBottom: 6 }}>
            {docs.map((d) => (
              <div
                key={d.id}
                className="r sel-lec"
                aria-pressed={pickedDoc === d.id}
                {...pressable(() => {
                  setPickedLecture(null);
                  setPickedDoc((p) => (p === d.id ? null : d.id));
                })}
              >
                <span className="ri">
                  <Icon name={KIND_ICON[docKind(d.kind)]} />
                </span>
                <span className="rt">
                  <b>{records.find((t) => t.id === d.transcriptionId)?.title ?? d.title}</b>
                  <span>{KIND_LABEL[docKind(d.kind)]}</span>
                </span>
                {pickedDoc === d.id && (
                  <span className="chev sel-mark"><Icon name="check" /></span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="fieldlbl">Или вставьте текст</div>
        <textarea
          className="topic"
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
            // Вставила свой текст — значит, собирать из него, а не из выбранного выше.
            if (e.target.value.trim() !== '') {
              setPickedLecture(null);
              setPickedDoc(null);
            }
          }}
          placeholder="Вставьте текст выступления — хотя бы пару абзацев."
        />

        {/* Стиль серии показываем, только когда есть из чего выбирать */}
        {packs.length > 1 && (
          <>
            <div className="fieldlbl">Стиль серии</div>
            <div className="pills">
              {packs.map((p) => {
                const on = (pickedPack ?? packs[0].id) === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`pill-opt ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    onClick={() => setPickedPack(p.id)}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Подпись стоит вплотную к кнопке и называет её: пока кнопка не
          нажата, текст живёт только в этом браузере. */}
      {fromText && rawText.trim() !== '' && (
        <p className="draft-note">
          <Icon name="check" /> Чтобы сохранить текст, нажмите «Разложить по слайдам».
          Пока он только в этом браузере.
        </p>
      )}
      <button className="btn primary big" disabled={busy} onClick={() => void create()}>
        {busy ? 'Начинаю…' : 'Разложить по слайдам'} <Icon name="arrow" />
      </button>
    </section>
  );
}
