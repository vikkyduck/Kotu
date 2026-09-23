import { useCallback, useEffect, useState } from 'react';

/**
 * Одна расшифровка и её состояние.
 *
 * Пока сервер распознаёт речь, запись опрашивается — так прогресс на экране
 * движется сам. Как только работа закончена (готово или ошибка), опрос
 * прекращается: дальше меняет запись только автор. Повтор после ошибки
 * возвращает запись в работу — и опрос возобновляется сам, по статусу.
 */

export interface TranscriptSegment {
  who: string;
  text: string;
}

export interface Transcription {
  id: number;
  title: string;
  filename: string;
  hideNames: boolean;
  markSpeakers: boolean;
  segments: TranscriptSegment[];
  status: 'queued' | 'processing' | 'done' | 'error';
  progress: number;
  statusMessage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Как часто спрашивать сервер, пока идёт распознавание. */
const POLL_MS = 1500;

export function useTranscription(id: number | null): {
  data: Transcription | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Правка текста автором: сохраняет и подставляет ответ сервера. */
  save: (patch: { segments?: TranscriptSegment[]; title?: string }) => Promise<boolean>;
  /** Повтор проваленной расшифровки из сохранённого на сервере аудио. */
  retry: () => Promise<boolean>;
} {
  const [data, setData] = useState<Transcription | null>(null);
  const [loading, setLoading] = useState(id !== null);

  const reload = useCallback(async () => {
    if (id === null) return;
    try {
      const res = await fetch(`/api/transcriptions/${id}`);
      if (res.ok) setData(await res.json());
    } catch {
      /* тихо: следующий опрос повторит */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id === null) {
      setData(null);
      setLoading(false);
      return;
    }
    // Открыли другую запись — старую не показываем ни мгновения.
    setData(null);
    setLoading(true);
    void reload();
  }, [id, reload]);

  const working = data?.status === 'processing' || data?.status === 'queued';
  useEffect(() => {
    if (id === null || !working) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [id, working, reload]);

  const save = useCallback(
    async (patch: { segments?: TranscriptSegment[]; title?: string }) => {
      if (id === null) return false;
      try {
        const res = await fetch(`/api/transcriptions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) return false;
        setData(await res.json());
        return true;
      } catch {
        return false;
      }
    },
    [id],
  );

  const retry = useCallback(async () => {
    if (id === null) return false;
    try {
      const res = await fetch(`/api/transcriptions/${id}/retry`, { method: 'POST' });
      if (!res.ok) return false;
      // Ответ — уже запись в работе: подставляем сразу, чтобы экран ошибки
      // сменился прогрессом без ожидания, а опрос пошёл по новому статусу.
      setData(await res.json());
      return true;
    } catch {
      return false;
    }
  }, [id]);

  return { data, loading, reload, save, retry };
}

/** Удалить запись вместе с аудио и библиотечной копией. */
export async function deleteTranscription(id: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/transcriptions/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
