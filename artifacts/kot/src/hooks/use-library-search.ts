import { useEffect, useState } from 'react';
import type { Hit } from '@/lib/library-items';

/** Пока запрос короче — ищем не по нему, а по всему подряд: смысла нет. */
const MIN_QUERY = 2;

/**
 * Поиск по смыслу во всех материалах: книгах, расшифровках, своих лекциях
 * и презентациях. Запрос уходит не на каждую букву, а после паузы в наборе —
 * иначе на каждое слово приходилось бы по десятку поисков.
 */
export function useLibrarySearch(query: string): { hits: Hit[] | null; searching: boolean } {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          if (res.ok) {
            const data = await res.json();
            setHits(data.results ?? []);
          }
        } catch {
          /* тихо: следующий набор повторит */
        } finally {
          setSearching(false);
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [query]);

  return { hits, searching };
}

export { MIN_QUERY };
