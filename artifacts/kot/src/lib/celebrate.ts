export const Celebrate = (() => {
  let cv: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let parts: any[] = [];
  let rings: any[] = [];
  let raf = 0;
  let last = 0;

  function init() {
    if (cv) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    if (reduce) return;

    cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:100';
    document.body.appendChild(cv);
    ctx = cv.getContext('2d');
    
    function resize() {
      if (!cv || !ctx) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    
    resize();
    window.addEventListener('resize', resize);
  }

  function pal() {
    const paperTheme = document.documentElement.getAttribute('data-theme') === 'light';
    return paperTheme
      ? [[48, 43, 39], [123, 67, 47], [138, 106, 59], [103, 113, 132], [94, 89, 82]]
      : [[216, 199, 167], [196, 173, 135], [176, 141, 87], [182, 124, 90], [103, 113, 132]];
  }

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const eoc = (x: number) => 1 - Math.pow(1 - x, 3);

  function start() {
    if (!raf && ctx) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  function loop(t: number) {
    if (!ctx) return;
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    ctx.clearRect(0, 0, W, H);
    
    rings = rings.filter(r => {
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) return false;
      const rad = r.r0 + (r.r1 - r.r0) * eoc(k);
      ctx!.beginPath();
      ctx!.arc(r.x, r.y, rad, 0, 6.2832);
      ctx!.strokeStyle = `rgba(${r.c},${(1 - k) * r.a})`;
      ctx!.lineWidth = Math.max(0.4, r.w * (1 - k));
      ctx!.stroke();
      return true;
    });
    
    parts = parts.filter(p => {
      p.t += dt;
      if (p.t >= p.life) return false;
      p.vy += p.g * dt;
      const f = Math.pow(p.drag, dt * 60);
      p.vx *= f;
      p.vy *= f;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.t / p.life;
      let a = p.a * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
      a = Math.max(0, a);
      const tw = 0.82 + 0.18 * Math.sin(p.t * p.tw * 6.28 + p.ph);
      const rr = p.r * 2.4;
      const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      g.addColorStop(0, `rgba(${p.c},${a * tw})`);
      g.addColorStop(0.5, `rgba(${p.c},${a * tw * 0.45})`);
      g.addColorStop(1, `rgba(${p.c},0)`);
      ctx!.fillStyle = g;
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, rr, 0, 6.2832);
      ctx!.fill();
      return true;
    });
    
    if (parts.length || rings.length) {
      raf = requestAnimationFrame(loop);
    } else {
      raf = 0;
      ctx.clearRect(0, 0, W, H);
    }
  }

  function emit(x: number, y: number, n: number, o: any = {}) {
    init();
    if (!cv) return;
    const P = pal();
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.2832);
      const spd = rand(o.smin || 90, o.smax || 260);
      const c = P[(Math.random() * P.length) | 0];
      parts.push({
        x, y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd - (o.up || 0),
        g: rand(150, 300),
        drag: 0.9,
        r: rand(1.1, 3.4),
        c: c.join(','),
        a: rand(0.7, 1),
        t: 0,
        life: rand(0.9, 1.6),
        tw: rand(0.5, 1.4),
        ph: rand(0, 6.28)
      });
    }
    start();
  }

  function ring(x: number, y: number, o: any = {}) {
    init();
    if (!cv) return;
    const paperTheme = document.documentElement.getAttribute('data-theme') === 'light';
    rings.push({
      x, y,
      r0: o.r0 || 6,
      r1: o.r1 || 120,
      dur: o.dur || 0.7,
      w: o.w || 2.5,
      a: o.a || 0.5,
      c: o.c || (paperTheme ? '123,67,47' : '216,199,167'),
      t: 0
    });
    start();
  }

  return {
    burst(x: number, y: number) {
      ring(x, y, { r1: 96, dur: 0.62 });
      emit(x, y, 30, { smin: 90, smax: 240, up: 34 });
    },
    success(x: number, y: number) {
      ring(x, y, { r0: 32, r1: 170, dur: 0.95, w: 3 });
      ring(x, y, { r0: 32, r1: 250, dur: 1.25, w: 1.4, a: 0.28 });
      emit(x, y, 66, { smin: 130, smax: 360, up: 20 });
      start();
    }
  };
})();