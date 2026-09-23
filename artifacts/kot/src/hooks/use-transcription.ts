import { useCallback, useEffect, useState } from 'react';
import type { TranscriptSegment, TranscriptionStatus } from '@workspace/db/schema';
import { OFFLINE, failText, json, send } from '@/lib/http';

/**
 * Одна расшифровка и её состояние.
 *
 * Пока сервер распознаёт речь, запись опрашивается — так прогресс на экране
 * движется сам. Как только работа закончена (готово или ошибка), опрос
 * прекращается: дальше меняет запись только автор. Повтор после ошибки
 * возвращает запись в работу — и опрос возобновляется сам, по статусу.
 */

export type { TranscriptSegment };

/** Запись, как её отдаёт API: форма строки из lib/db, даты — строками. */
export interface Transcription {
  id: number;
  title: string;
  filename: string;
  hideNames: boolean;
  markSpeakers: boolean;
  segments: TranscriptSegment[];
  status: TranscriptionStatus;
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
  /** Почему запись не открылась: её нет (404) или сервер не ответил. */
  failed: 'missing' | 'error' | null;
  reload: () => Promise<void>;
  /** Правка автором: сохраняет и подставляет ответ сервера. null — сохранено, иначе текст ошибки. */
  save: (patch: { segments?: TranscriptSegment[]; title?: string }) => Promise<string | null>;
  /**
   * Повтор проваленной расшифровки из сохранённого на сервере аудио.
   * null — запись снова в работе; иначе код ответа (0 — нет сети) и текст.
   */
  retry: () => Promise<{ status: number; message: string } | null>;
} {
  const [data, setData] = useState<Transcription | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null);

  const reload = useCallback(async () => {
    if (id === null) return;
    try {
      const res = await fetch(`/api/transcriptions/${id}`);
      if (res.ok) {
        setData(await res.json());
        setFailed(null);
      } else {
        setFailed(res.status === 404 ? 'missing' : 'error');
      }
    } catch {
      setFailed('error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // Открыли другую запись — старую не показываем ни мгновения.
    setData(null);
    setFailed(null);
    if (id === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
  }, [id, reload]);

  const working = data?.status === 'processing';
  useEffect(() => {
    if (id === null || !working) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [id, working, reload]);

  const save = useCallback(
    async (patch: { segments?: TranscriptSegment[]; title?: string }) => {
      if (id === null) return null;
      const r = await send(`/api/transcriptions/${id}`, json('PATCH', patch), 'Не удалось сохранить');
      if (!r.ok) return r.message;
      setData(await r.res.json());
      return null;
    },
    [id],
  );

  const retry = useCallback(async () => {
    if (id === null) return null;
    try {
      const res = await fetch(`/api/transcriptions/${id}/retry`, { method: 'POST' });
      if (res.ok) {
        // Ответ — уже запись в работе: подставляем сразу, чтобы экран ошибки
        // сменился прогрессом без ожидания, а опрос пошёл по новому статусу.
        setData((await res.json()) as Transcription);
        return null;
      }
      const message = await failText(res, 'Не удалось повторить');
      if (res.status === 409) {
        // Возможно, запись уже повторили (другая вкладка, двойной клик) — тогда
        // показываем её как есть, а не уводим на новую загрузку.
        const fresh = await fetch(`/api/transcriptions/${id}`);
        const row = fresh.ok ? ((await fresh.json()) as Transcription) : null;
        if (row && row.status !== 'error') {
          setData(row);
          return null;
        }
      }
      return { status: res.status, message };
    } catch {
      return { status: 0, message: OFFLINE };
    }
  }, [id]);

  return { data, loading, failed, reload, save, retry };
}

/** Удалить запись вместе с аудио и библиотечной копией. null — удалена, иначе текст ошибки. */
export async function deleteTranscription(id: number): Promise<string | null> {
  const r = await send(`/api/transcriptions/${id}`, { method: 'DELETE' }, 'Не удалось удалить');
  return r.ok ? null : r.message;
}
