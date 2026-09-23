import { Icon } from '@/lib/icons';
import { countLabel, type Folder } from '@/lib/library-items';
import { dropZone, type DropTarget } from '@/lib/dnd';
import type { DragEvent } from 'react';

/**
 * Полка папок. Папка — место, куда заходят, а не подпись над списком:
 * на плитку можно бросить материал мышкой, внутри неё живут свои действия.
 */
interface Props {
  folders: Folder[];
  countIn: (folderId: number) => number;
  dropTarget: DropTarget;
  setDropTarget: (t: DropTarget | ((prev: DropTarget) => DropTarget)) => void;
  onDropTo: (e: DragEvent, folderId: number | null) => void;
  onOpen: (folderId: number) => void;
  onCreate: () => void;
}

export function FolderTiles({
  folders,
  countIn,
  dropTarget,
  setDropTarget,
  onDropTo,
  onOpen,
  onCreate,
}: Props) {
  return (
    <div className="folder-grid">
      {folders.map((f) => (
        <button
          key={f.id}
          className={`folder-tile ${dropTarget === f.id ? 'drop-over' : ''}`}
          onClick={() => onOpen(f.id)}
          {...dropZone(f.id, setDropTarget, (e) => onDropTo(e, f.id))}
        >
          <span className="folder-tile-ico"><Icon name="folder" /></span>
          <span className="folder-tile-body">
            <b>{f.name}</b>
            <span>{countLabel(countIn(f.id))}</span>
          </span>
          <span className="folder-tile-chev"><Icon name="chevron" /></span>
        </button>
      ))}

      <button className="folder-tile folder-tile-add" onClick={onCreate}>
        <span className="folder-tile-ico"><Icon name="folder" /></span>
        <span className="folder-tile-body"><b>Новая папка</b><span>разложить по темам</span></span>
      </button>
    </div>
  );
}
