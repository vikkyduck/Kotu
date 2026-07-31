import { useCallback, useEffect, useState } from 'react';
import { isBusy, type Doc, type Folder, type LectureRow, type DeckRow, type TranscriptionRow, type LibraryData } from '@/lib/library-items';

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
  reload: () => Promise<void>;
} {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [lectures, setLectures] = useState<LectureRow[]>([]);
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionRow[]>([]);

  const reload = useCallback(async () => {
    try {
      const [d, f, l, k, t] = await Promise.all([
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/folders').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/lectures').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/decks').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/transcriptions').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (d) setDocs(d);
      if (f) setFolders(f);
      if (l) setLectures(l);
      if (k) setDecks(k);
      if (t) setTranscriptions(t);
    } catch {
      /* сеть моргнула — покажем то, что уже есть */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void reload();
  }, [active, reload]);

  const data: LibraryData = { docs: docs ?? [], lectures, decks, transcriptions };
  const busy = isBusy(data);

  useEffect(() => {
    if (!active || !busy) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [active, busy, reload]);

  return { data, folders, loaded: docs !== null, reload };
}
