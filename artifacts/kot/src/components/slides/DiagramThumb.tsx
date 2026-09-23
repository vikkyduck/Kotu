import { SLIDE_SPEC } from '@workspace/db/slides';
import type { DiagramSpec } from '@/lib/deck';

/**
 * Мини-схема на пластине готовой колоды: пиктограмма структуры без подписей —
 * с плитки читается состав (сколько шагов и как они стоят), текст есть в
 * раскадровке и в самом PPTX. stroke currentColor, чтобы схема писалась
 * тем же пером, что рамка серии.
 */
export function DiagramThumb({ spec }: { spec: DiagramSpec }) {
  const pad = 18;
  if (spec.kind === 'flow') {
    const n = spec.items.length;
    const gap = 11;
    const h = (180 - pad * 2 - gap * (n - 1)) / n;
    const w = 150;
    const x = (320 - w) / 2;
    return (
      <svg viewBox="0 0 320 180" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {spec.items.map((_, i) => {
          const y = pad + i * (h + gap);
          return (
            <g key={i}>
              <rect x={x} y={y} width={w} height={h} />
              {/* стрелка вниз: линия в просвете + шеврон на конце */}
              {i < n - 1 && <path d={`M160 ${y + h + 2} v${gap - 5} m-4 -4 l4 4 l4 -4`} />}
            </g>
          );
        })}
      </svg>
    );
  }
  // Колонны: как в экспорте и на пластине, больше maxItems рядом не ставим.
  const cols = spec.items.slice(0, SLIDE_SPEC.diagram.maxItems);
  const gap = 12;
  const w = (320 - pad * 2 - gap * (cols.length - 1)) / cols.length;
  return (
    <svg viewBox="0 0 320 180" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {cols.map((_, i) => (
        <rect key={i} x={pad + i * (w + gap)} y={pad} width={w} height={180 - pad * 2} />
      ))}
    </svg>
  );
}
