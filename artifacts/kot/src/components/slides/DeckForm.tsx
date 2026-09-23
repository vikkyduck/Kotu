import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { useDraft, useUnsavedWarning } from '@/hooks/use-draft';
import { Icon } from '@/lib/icons';
import { send, json } from '@/lib/http';
import { KIND_LABEL, docKind } from '@/lib/library-items';

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
  status: string;
}

/** Документ библиотеки — тоже законный источник презентации. */
interface DocItem {
  id: number;
  title: string;
  kind: string;
  status: string;
}

interface StylePackItem {
  id: number;
  name: string;
}

interface Props {
  active: boolean;
  onCreated: (deckId: number) => void;
}

export function DeckForm({ active, onCreated }: Props) {
  const { go, toast, deckSeed } = useApp();

  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [packs, setPacks] = useState<StylePackItem[]>([]);

  const [pickedLecture, setPickedLecture] = useState<number | null>(null);
  const [pickedDoc, setPickedDoc] = useState<number | null>(null);
  // Стиль серии: null = «не выбирал», тогда действует первый из списка.
  const [pickedPack, setPickedPack] = useState<number | null>(null);
  // Вставленный текст — черновик: до нажатия кнопки сервер о нём не знает,
  // поэтому он переживает закрытие вкладки сам.
  const [rawText, setRawText, clearRawText] = useDraft('deck-text', active);
  const [busy, setBusy] = useState(false);

  useUnsavedWarning(active && rawText.trim() !== '');

  const load = useCallback(async () => {
    try {
      const [l, d, p] = await Promise.all([
        fetch('/api/lectures').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/style-packs').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (l) setLectures((l as LectureItem[]).filter((x) => x.status === 'ready'));
      // Текст лекции и текст колоды — их поисковые копии: лекция уже стоит
      // отдельным списком выше, а собирать презентацию из презентации незачем.
      if (d)
        setDocs(
          (d as DocItem[]).filter(
            (x) => x.status === 'ready' && x.kind !== 'lecture' && x.kind !== 'deck',
          ),
        );
      if (p) setPacks(p);
    } catch {
      /* тихо: без списков сервер сам возьмёт стиль по умолчанию */
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // Пришли из библиотеки с материалом («сделать презентацию из этого») —
  // источник уже выбран, автору остаётся нажать одну кнопку.
  useEffect(() => {
    if (!active || !deckSeed) return;
    if (deckSeed.sourceKind === 'lecture') {
      setPickedLecture(deckSeed.sourceId);
      setPickedDoc(null);
    } else {
      setPickedDoc(deckSeed.sourceId);
      setPickedLecture(null);
    }
  }, [active, deckSeed]);

  useEffect(() => {
    if (active) return;
    setPickedLecture(null);
    setPickedDoc(null);
    setPickedPack(null);
  }, [active]);

  const create = async () => {
    const raw = rawText.trim();
    if (pickedLecture === null && pickedDoc === null && raw === '') {
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
      <p className="sub">
        Возьму за основу готовую лекцию, документ из библиотеки — или текст, который вставите.
      </p>

      <div className="panel">
        <div className="fieldlbl">Из готовой лекции</div>
        {lectures.length === 0 ? (
          <p className="doc-meta">Готовых лекций пока нет.</p>
        ) : (
          <div className="resume" style={{ marginBottom: 6 }}>
            {lectures.map((l) => (
              <div
                key={l.id}
                className="r sel-lec"
                onClick={() => {
                  setPickedDoc(null);
                  setPickedLecture((p) => (p === l.id ? null : l.id));
                }}
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
        {docs.length === 0 ? (
          <p className="doc-meta">В библиотеке пока нет разобранных документов.</p>
        ) : (
          <div className="resume" style={{ marginBottom: 6 }}>
            {docs.map((d) => (
              <div
                key={d.id}
                className="r sel-lec"
                onClick={() => {
                  setPickedLecture(null);
                  setPickedDoc((p) => (p === d.id ? null : d.id));
                }}
              >
                <span className="ri">
                  <Icon name={d.kind === 'transcript' ? 'mic' : 'book'} />
                </span>
                <span className="rt">
                  <b>{d.title}</b>
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
              {packs.map((p) => (
                <span
                  key={p.id}
                  className={`pill-opt ${(pickedPack ?? packs[0].id) === p.id ? 'on' : ''}`}
                  onClick={() => setPickedPack(p.id)}
                >
                  {p.name}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Подпись стоит вплотную к кнопке и называет её: пока кнопка не
          нажата, текст живёт только в этом браузере. */}
      {rawText.trim() !== '' && (
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
