import { useEffect } from 'react';

export function useLiquidLight() {
  useEffect(() => {
    const SEL = '.task,.promise,.panel,.filecard,.slide,.sheet,.btn.primary';
    let lx = 0;
    let ly = 0;
    let tgt: any = null;
    let raf = 0;

    function apply() {
      raf = 0;
      const el = tgt && tgt.closest && tgt.closest(SEL);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', ((lx - r.left) / r.width * 100).toFixed(1) + '%');
      el.style.setProperty('--my', ((ly - r.top) / r.height * 100).toFixed(1) + '%');
    }

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      lx = e.clientX;
      ly = e.clientY;
      tgt = e.target;
      if (!raf) raf = requestAnimationFrame(apply);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, []);
}
