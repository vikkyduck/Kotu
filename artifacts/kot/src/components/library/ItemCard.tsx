import { useState, type DragEvent } from 'react';
import { Icon } from '@/lib/icons';
import { ITEM_MIME } from '@/lib/dnd';
import { KIND_ICON, type Folder, type Item } from '@/lib/library-items';

/**
 * Карточка материала: одинаковая для книги, расшифровки, лекции и презентации.
 * Отличается только значком, подписью и набором действий — так библиотека
 * говорит на одном языке про всё, что в ней лежит.
 */

/** Какой ряд кнопок раскрыт под карточкой. Открыт всегда один — не ёлка. */
export type CardMenu = 'move' | 'use';

interface Props {
  item: Item;
  folders: Folder[];
  menu: CardMenu | null;
  onMenu: (menu: CardMenu | null) => void;
  onMove: (item: Item, folderId: number | null) => void;
  onCreateFolder: () => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function ItemCard({
  item,
  folders,
  menu,
  onMenu,
  onMove,
  onCreateFolder,
  dragging,
  onDragStart,
  onDragEnd,
}: Props) {
  /**
   * Карточка «берётся» только когда указатель на грипе: draggable на всей
   * карточке перехватывал бы нажатия на кнопки и на название — браузер ищет
   * источник перетаскивания вверх по дереву и всё равно упирался бы в неё.
   */
  const [grabbable, setGrabbable] = useState(false);
  const movable = item.api !== undefined;
  /** Удаление в два шага: спросили — и через несколько секунд забыли. */
  const [confirming, setConfirming] = useState(false);

  return (
    <div>
      <div
        className={`doc-card ${item.tone === 'bad' ? 'error' : ''} ${dragging ? 'dragging' : ''}`}
        draggable={movable && grabbable}
        onDragStart={(e: DragEvent) => {
          e.dataTransfer.setData(ITEM_MIME, item.key);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <span
          className={`doc-ico ${movable ? 'grip' : ''}`}
          title={movable ? 'Потяните, чтобы переложить в папку' : undefined}
          onMouseEnter={() => movable && setGrabbable(true)}
          onMouseLeave={() => setGrabbable(false)}
        >
          <Icon name={KIND_ICON[item.kind]} />
        </span>

        <div className="doc-body">
          {item.open ? (
            // Название — ссылка и для клавиатуры: Tab до него, Enter или пробел.
            <b
              className="doc-title doc-link"
              role="button"
              tabIndex={0}
              onClick={item.open}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                item.open?.();
              }}
            >
              {item.title}
            </b>
          ) : (
            <b className="doc-title">{item.title}</b>
          )}
          <span className={`doc-meta ${item.tone}`}>{item.meta}</span>
        </div>

        {(item.makeDeck || item.makeLecture) && (
          <button
            className="btn ghost doc-use"
            title="Сделать из этого"
            onClick={() => onMenu(menu === 'use' ? null : 'use')}
          >
            <Icon name="spark" />
          </button>
        )}

        {item.rename && (
          <button className="btn ghost doc-move" title="Переименовать" onClick={item.rename}>
            <Icon name="edit" />
          </button>
        )}

        {movable && (
          <button
            className="btn ghost doc-move"
            title="Переложить в папку"
            onClick={() => onMenu(menu === 'move' ? null : 'move')}
          >
            <Icon name="folder" />
          </button>
        )}

        {item.del ? (
          confirming ? (
            // Второй щелчок двойного клика по корзине попадает уже сюда —
            // его (detail 2) не считаем подтверждением.
            <button
              key="confirm"
              className="btn danger doc-del"
              onClick={(e) => {
                if (e.detail < 2) item.del?.();
              }}
            >
              Точно удалить?
            </button>
          ) : (
            <button
              key="ask"
              className="btn ghost doc-del"
              title="Удалить"
              onClick={() => {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 4000);
              }}
            >
              <Icon name="trash" />
            </button>
          )
        ) : item.kind === 'transcript' && item.open ? (
          // Расшифровка живёт вместе с записью — и удаляется там же, где аудио.
          <button className="btn ghost doc-del" title="Удалить можно на экране записи" onClick={item.open}>
            <Icon name="trash" />
          </button>
        ) : null}
      </div>

      {menu === 'use' && (
        <div className="pills folder-pills">
          {item.makeDeck && (
            <button className="pill-opt" onClick={item.makeDeck}>
              собрать презентацию
            </button>
          )}
          {item.makeLecture && (
            <button className="pill-opt" onClick={item.makeLecture}>
              написать лекцию на основе
            </button>
          )}
        </div>
      )}

      {menu === 'move' && (
        <div className="pills folder-pills">
          {folders
            .filter((f) => f.id !== item.folderId)
            .map((f) => (
              <button key={f.id} className="pill-opt" onClick={() => onMove(item, f.id)}>
                {f.name}
              </button>
            ))}
          {item.folderId !== null && (
            <button className="pill-opt" onClick={() => onMove(item, null)}>
              вынуть из папки
            </button>
          )}
          {folders.length === 0 && (
            <button className="pill-opt" onClick={onCreateFolder}>
              создать папку
            </button>
          )}
        </div>
      )}
    </div>
  );
}
