import { useEffect, useState } from 'react';
import { send } from '@/lib/http';
import type { Hit } from '@/lib/library-items';

/** Пока запрос короче — ищем не по нему, а по всему подряд: смысла нет. */
const MIN_QUERY = 2;

/**
 * Поиск по смыслу во всех материалах: книгах, расшифровках, своих лекциях
 * и презентациях. Запрос уходит не на каждую букву, а после паузы в наборе —
 * иначе на каждое слово приходилось бы по десятку поисков.
 */
export function useLibrarySearch(query: string): {
  hits: Hit[] | null;
  searching: boolean;
  /** Поиск не ответил — фраза вместо «ничего не нашла». */
  error: string | null;
} {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    setError(null);
    if (q.length < MIN_QUERY) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    // Ответ на прежний запрос может прийти позже нового (векторы считаются
    // не мгновенно) — такой ответ уже никому не нужен.
    let stale = false;
    const t = setTimeout(() => {
      void (async () => {
        const r = await send(
          `/api/search?q=${encodeURIComponent(q)}`,
          undefined,
          'Поиск сейчас недоступен — попробуйте чуть позже',
        );
        const next = r.ok
          ? (((await r.res.json().catch(() => ({}))) as { results?: Hit[] }).results ?? [])
          : null;
        if (stale) return;
        setHits(next);
        setError(r.ok ? null : r.message);
        setSearching(false);
      })();
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  return { hits, searching, error };
}

export { MIN_QUERY };
