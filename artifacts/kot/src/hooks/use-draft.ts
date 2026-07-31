import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Черновик формы, переживающий закрытие вкладки.
 *
 * Пока автор не нажал кнопку, вставленный текст живёт только в браузере:
 * сервер о нём не знает. Закрытая вкладка — и работа пропала, хотя рядом
 * стояла успокаивающая фраза «можно закрыть страницу» (она про уже
 * запущенный конвейер, но читается как обещание на весь экран).
 *
 * Поэтому текст сохраняется в этом же браузере на каждое изменение и
 * возвращается на место при следующем заходе. Уходит он ровно в двух
 * случаях: работа началась или автор сам очистил поле.
 */
export function useDraft(key: string, active: boolean): [string, (v: string) => void, () => void] {
  const storageKey = `kot-draft:${key}`;
  const [value, setValue] = useState('');
  const restored = useRef(false);

  useEffect(() => {
    if (!active || restored.current) return;
    restored.current = true;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setValue(saved);
    } catch {
      /* приватный режим браузера — тогда просто без черновика */
    }
  }, [active, storageKey]);

  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        if (next.trim() === '') localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, next);
      } catch {
        /* см. выше */
      }
    },
    [storageKey],
  );

  const clear = useCallback(() => {
    setValue('');
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* см. выше */
    }
  }, [storageKey]);

  return [value, update, clear];
}

/**
 * Предупреждение браузера при уходе с недописанной формой. Черновик и так
 * сохранится, но случайно закрытая вкладка — почти всегда промах по крестику,
 * и вопрос «точно уходим?» стоит одной секунды.
 */
export function useUnsavedWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Текст диалога задаёт сам браузер; непустой returnValue его включает.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [active]);
}
