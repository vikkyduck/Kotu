import type { DragEvent } from 'react';

/**
 * Перетаскивание материала мышкой.
 *
 * Свой тип данных, а не text/plain: так зона сброса отличает карточку
 * библиотеки от файла, который тащат из проводника, и ведёт себя по-разному —
 * карточку перекладывает, файл загружает.
 */
export const ITEM_MIME = 'application/x-kotu-item';

/** Куда целятся: номер папки или корень библиотеки. */
export type DropTarget = number | 'root' | null;

interface DropHandlers {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/**
 * Делает из зоны цель для сброса: подсвечивает её, пока над ней что-то держат,
 * и сообщает о сбросе.
 */
export function dropZone(
  key: number | 'root',
  setTarget: (t: DropTarget | ((prev: DropTarget) => DropTarget)) => void,
  onDrop: (e: DragEvent) => void,
): DropHandlers {
  return {
    onDragOver: (e) => {
      // Смотрим на сам dataTransfer, а не на состояние React: первый dragover
      // прилетает раньше, чем доедет setState.
      const types = e.dataTransfer.types;
      const isItem = types.indexOf(ITEM_MIME) !== -1;
      const isFile = types.indexOf('Files') !== -1;
      if (!isItem && !isFile) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isItem ? 'move' : 'copy';
      setTarget(key);
    },
    onDragLeave: (e) => {
      // Уход к дочернему элементу — не уход из зоны.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setTarget((t) => (t === key ? null : t));
    },
    onDrop,
  };
}
