import { useCallback, useEffect, useState } from 'react';
import { isBusy, type Doc, type Folder, type LectureRow, type DeckRow, type TranscriptionRow, type LibraryData } from '@/lib/library-items';

/**
 * «Библиотека изменилась» — от другого экрана: запись догрузилась, пока автор
 * уже ушёл в библиотеку, а сама она опрашивает сервер, только пока что-то
 * в работе. window.dispatchEvent(new Event(LIBRARY_CHANGED)) — и списки
 * перечитаются; вне библиотеки событие никто не слушает.
 */
export const LIBRARY_CHANGED = 'kot:library';

/**
 * Пять списков, из которых складывается библиотека, и их обновление.
 *
 * Все пять грузятся вместе: библиотека показывает их одной лентой, и приезжать
 * они должны тоже разом — иначе карточки прыгают. Пока что-то делается,
 * список опрашивается сам, чтобы готовая работа переехала из «в работе»
 * в библиотеку без нажатия «обновить».
 */
export function useLibraryData(active: boolean): {
  data: LibraryData;
  folders: Folder[];
  /** null, пока первый ответ не пришёл: экран показывает «открываю библиотеку». */
  loaded: boolean;
  /**
   * Последняя загрузка не удалась. Экран смотрит на это, только пока ничего
   * не загружено: вместо вечного «открываю» — «ещё раз». Потом фоновые сбои
   * не видны — список уже на экране.
   */
  failed: boolean;
  reload: () => Promise<void>;
} {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [lectures, setLectures] = useState<LectureRow[]>([]);
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionRow[]>([]);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [d, f, l, k, t] = await Promise.all([
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/folders').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/lectures').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/decks').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/transcriptions').then((r) => (r.ok ? r.json() : null)),
      ]);
      // Всё или ничего: без папок материалы легли бы в корень, будто папки
      // стёрты, а без записей копии расшифровок потеряли бы имена. На экране
      // остаётся прошлый полный снимок, а при первой загрузке — «ещё раз».
      if (!d || !f || !l || !k || !t) {
        setFailed(true);
        return;
      }
      setDocs(d);
      setFolders(f);
      setLectures(l);
      setDecks(k);
      setTranscriptions(t);
      setFailed(false);
    } catch {
      /* сеть моргнула — покажем то, что уже есть */
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void reload();
    const onChanged = () => void reload();
    window.addEventListener(LIBRARY_CHANGED, onChanged);
    return () => window.removeEventListener(LIBRARY_CHANGED, onChanged);
  }, [active, reload]);

  const data: LibraryData = { docs: docs ?? [], lectures, decks, transcriptions };
  const busy = isBusy(data);

  useEffect(() => {
    if (!active || !busy) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [active, busy, reload]);

  return { data, folders, loaded: docs !== null, failed, reload };
}
