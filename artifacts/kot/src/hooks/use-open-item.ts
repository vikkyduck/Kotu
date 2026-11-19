import { useCallback, useEffect, useRef, useState } from 'react';
import { OFFLINE, failText } from '@/lib/http';

/** Как часто спрашивать сервер, пока над открытой вещью идёт работа. */
export const POLL_MS = 2000;

/**
 * Открытая по номеру вещь - лекция, презентация, запись. Одно правило на
 * все экраны: загрузить; её нет (404) - missing, экран уводит в библиотеку;
 * другой сбой - error с причиной; пока идёт работа - опрашивать сервер, чтобы
 * прогресс двигался сам. Ответ по прежней вещи, пришедший после перехода на
 * другую, на экран не встаёт.
 */
export function useOpenItem<T>(
  id: number | null,
  urlOf: (id: number) => string,
  isWorking: (item: T) => boolean,
  failMessage: string,
): {
  item: T | null;
  /** Подставить ответ действия (сохранение, повтор), не дожидаясь опроса. */
  setItem: (item: T) => void;
  loading: boolean;
  /** Вещи нет: удалили в другой вкладке, старая ссылка, «назад» после удаления. */
  missing: boolean;
  /** Не открылась по другой причине - текст для экрана. */
  error: string | null;
  reload: () => Promise<void>;
} {
  const [item, setItem] = useState<T | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useRef(id);
  current.current = id;
  // Адрес строится функцией экрана; держим последнюю, чтобы не перезапускать загрузку.
  const urlRef = useRef(urlOf);
  urlRef.current = urlOf;

  const reload = useCallback(async () => {
    if (id === null) return;
    try {
      const res = await fetch(urlRef.current(id));
      if (id !== current.current) return;
      if (res.status === 404) {
        setMissing(true);
        return;
      }
      if (!res.ok) {
        setError(await failText(res, failMessage));
        return;
      }
      const row = (await res.json()) as T;
      if (id !== current.current) return;
      setItem(row);
      setError(null);
    } catch {
      if (id === current.current) setError(OFFLINE);
    } finally {
      if (id === current.current) setLoading(false);
    }
  }, [id, failMessage]);

  useEffect(() => {
    // Открыли другую вещь - прежняя не висит на экране ни мгновения.
    setItem(null);
    setError(null);
    setMissing(false);
    if (id === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
  }, [id, reload]);

  const working = item !== null && isWorking(item);
  useEffect(() => {
    if (id === null || !working) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [id, working, reload]);

  return { item, setItem, loading, missing, error, reload };
}
