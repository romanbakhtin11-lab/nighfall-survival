'use strict';
/*
 * Процедурная генерация всей графики в стиле 32-битного пиксель-арта.
 *
 * Всё рисуется один раз при загрузке в индексные буферы (индексы палитры),
 * затем упаковывается в один атлас. Игра обращается только к API:
 *   Sprites.init()                 — сгенерировать всё
 *   Sprites.get(name)              — { anims: { walk: [frame…], … } }
 *   Sprites.draw(ctx, frame, x, y, flip, flash)
 *   Sprites.tiles / decals / glow / shadow — для мира и эффектов
 * Кадр: { x, y, w, h, fx, fy, ax, ay } — прямоугольник в атласе,
 * прямоугольник белой «вспышки» и точка привязки (ноги).
 * Чтобы заменить процедурную графику на PNG, достаточно заполнить
 * ту же таблицу кадров из готового атласа — игровая логика не изменится.
 *
 * Свет везде один: сверху-слева. Тонирование — 3–5 тонов рампы
 * с упорядоченным дизерингом (Bayer 4×4) между соседними тонами.
 */
(function () {
  const P = window.Palette;
  const R = P.ramps;
  const INK = P.INK, WHITE = P.WHITE;

  // =====================================================================
  // Шум и случайность (детерминированные, через seed)
  // =====================================================================
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y, seed) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  /** Значение шума в точке; period > 0 делает шум бесшовным (для тайлов). */
  function valueNoise(x, y, seed, period) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    let x0 = ix, y0 = iy, x1 = ix + 1, y1 = iy + 1;
    if (period) {
      x0 = ((x0 % period) + period) % period; x1 = ((x1 % period) + period) % period;
      y0 = ((y0 % period) + period) % period; y1 = ((y1 % period) + period) % period;
    }
    const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
    const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }
  function fbm(x, y, seed, octaves, period) {
    let sum = 0, amp = 0.5, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += valueNoise(x * f, y * f, seed + o * 101, period ? period * f : 0) * amp;
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  }

  // =====================================================================
  // Свет, дизеринг, тонирование
  // =====================================================================
  const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
  function bayer(x, y) { return BAYER[((y & 3) << 2) | (x & 3)]; }

  const LLEN = Math.hypot(0.5, 0.65, 0.57);
  const LX = -0.5 / LLEN, LY = -0.65 / LLEN, LZ = 0.57 / LLEN;
  /** Освещённость 0..1 для нормали (свет сверху-слева, чуть на зрителя). */
  function lightAt(nx, ny, nz) { return (nx * LX + ny * LY + nz * LZ) * 0.75 + 0.3; }

  function toneIdx(n, I, x, y) {
    const t = I * (n - 1);
    if (t <= 0) return 0;
    if (t >= n - 1) return n - 1;
    const b = t | 0;
    return (t - b) > bayer(x, y) ? b + 1 : b;
  }
  function shade(ramp, I, x, y) { return ramp[toneIdx(ramp.length, I, x, y)]; }

  // =====================================================================
  // PixelBuffer — индексное изображение (0 = прозрачно)
  // =====================================================================
  class PixelBuffer {
    constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8Array(w * h); }
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      this.px[y * this.w + x] = c;
    }
    get(x, y) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
      return this.px[y * this.w + x];
    }
    clone() { const b = new PixelBuffer(this.w, this.h); b.px.set(this.px); return b; }
  }

  /** Тонкий тёмный контур вокруг непрозрачных пикселей (4-соседство). */
  function outline(buf, color) {
    const c = color || INK, w = buf.w, h = buf.h, src = buf.px, out = new Uint8Array(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (src[i]) continue;
        if ((x > 0 && src[i - 1] && src[i - 1] !== c) || (x < w - 1 && src[i + 1] && src[i + 1] !== c) ||
            (y > 0 && src[i - w] && src[i - w] !== c) || (y < h - 1 && src[i + w] && src[i + w] !== c)) out[i] = c;
      }
    }
    buf.px = out;
    return buf;
  }

  /** Поворот буфера (ближайший сосед) вокруг опорной точки. */
  function rotateBuffer(src, ang, pivX, pivY, outW, outH, outPX, outPY) {
    const b = new PixelBuffer(outW, outH);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const rx = x + 0.5 - outPX, ry = y + 0.5 - outPY;
        const sx = Math.floor(pivX + rx * c - ry * s), sy = Math.floor(pivY + rx * s + ry * c);
        const v = src.get(sx, sy);
        if (v) b.px[y * outW + x] = v;
      }
    }
    return b;
  }

  // =====================================================================
  // Painter — примитивы с объёмным освещением.
  // Координаты локальные; s — масштаб (для элитных версий и боссов).
  // =====================================================================
  class Painter {
    constructor(buf, s, ox, oy) { this.b = buf; this.s = s || 1; this.ox = ox || 0; this.oy = oy || 0; }

    /** Эллипсоид: основа тел, голов, крон, камней. */
    blob(cx, cy, rx, ry, ramp, bias, clipTop, clipBottom) {
      bias = bias || 0;
      const s = this.s, X = this.ox + cx * s, Y = this.oy + cy * s;
      const RX = Math.max(0.5, rx * s), RY = Math.max(0.5, ry * s);
      const yMin = clipTop === undefined ? -1e9 : this.oy + clipTop * s;
      const yMax = clipBottom === undefined ? 1e9 : this.oy + clipBottom * s;
      const x0 = Math.floor(X - RX), x1 = Math.ceil(X + RX), y0 = Math.floor(Y - RY), y1 = Math.ceil(Y + RY);
      for (let y = y0; y < y1; y++) {
        const py = y + 0.5;
        if (py < yMin || py > yMax) continue;
        const ny = (py - Y) / RY;
        for (let x = x0; x < x1; x++) {
          const nx = (x + 0.5 - X) / RX, d = nx * nx + ny * ny;
          if (d > 1) continue;
          this.b.set(x, y, shade(ramp, lightAt(nx, ny, Math.sqrt(1 - d)) + bias, x, y));
        }
      }
    }

    /** Капсула-цилиндр: руки, ноги, древки, ветви, хвосты. */
    limb(x0, y0, x1, y1, r, ramp, bias) {
      bias = bias || 0;
      const s = this.s;
      const ax = this.ox + x0 * s, ay = this.oy + y0 * s, bx = this.ox + x1 * s, by = this.oy + y1 * s;
      const RR = Math.max(0.55, r * s);
      const vx = bx - ax, vy = by - ay, ll = vx * vx + vy * vy || 1e-6;
      const minx = Math.floor(Math.min(ax, bx) - RR), maxx = Math.ceil(Math.max(ax, bx) + RR);
      const miny = Math.floor(Math.min(ay, by) - RR), maxy = Math.ceil(Math.max(ay, by) + RR);
      for (let y = miny; y < maxy; y++) {
        for (let x = minx; x < maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          let t = ((px - ax) * vx + (py - ay) * vy) / ll;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = (px - (ax + vx * t)) / RR, dy = (py - (ay + vy * t)) / RR, d = dx * dx + dy * dy;
          if (d > 1) continue;
          this.b.set(x, y, shade(ramp, lightAt(dx, dy, Math.sqrt(1 - d)) + bias, x, y));
        }
      }
    }

    /** Многоугольник с «подушечным» объёмом: плащи, мантии, крылья, шляпы. */
    poly(pts, ramp, bias, flat) {
      bias = bias || 0;
      const s = this.s, n = pts.length / 2, T = new Float32Array(pts.length);
      let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
      for (let i = 0; i < n; i++) {
        const x = this.ox + pts[i * 2] * s, y = this.oy + pts[i * 2 + 1] * s;
        T[i * 2] = x; T[i * 2 + 1] = y;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
      const hw = Math.max(1, (maxx - minx) / 2), hh = Math.max(1, (maxy - miny) / 2);
      for (let y = Math.floor(miny); y < Math.ceil(maxy); y++) {
        const py = y + 0.5;
        for (let x = Math.floor(minx); x < Math.ceil(maxx); x++) {
          const px = x + 0.5;
          let inside = false;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = T[i * 2], yi = T[i * 2 + 1], xj = T[j * 2], yj = T[j * 2 + 1];
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
          }
          if (!inside) continue;
          const nx = (px - cx) / hw * 0.85, ny = (py - cy) / hh * 0.85;
          let I;
          if (flat) I = 0.62 - ny * 0.22 - nx * 0.14;
          else I = lightAt(nx, ny, Math.sqrt(Math.max(0.08, 1 - nx * nx - ny * ny)));
          this.b.set(x, y, shade(ramp, I + bias, x, y));
        }
      }
    }

    /** Прямоугольная грань с градиентом освещения (верх/фасад блоков). */
    face(x, y, w, h, ramp, baseI, gx, gy) {
      const s = this.s;
      const X0 = Math.round(this.ox + x * s), Y0 = Math.round(this.oy + y * s);
      const X1 = Math.max(X0 + 1, Math.round(this.ox + (x + w) * s)), Y1 = Math.max(Y0 + 1, Math.round(this.oy + (y + h) * s));
      for (let yy = Y0; yy < Y1; yy++) {
        const v = (yy - Y0) / Math.max(1, Y1 - Y0 - 1);
        for (let xx = X0; xx < X1; xx++) {
          const u = (xx - X0) / Math.max(1, X1 - X0 - 1);
          this.b.set(xx, yy, shade(ramp, baseI - gx * u - gy * v, xx, yy));
        }
      }
    }

    px(x, y, c) {
      const s = this.s, X = Math.floor(this.ox + x * s), Y = Math.floor(this.oy + y * s), n = Math.max(1, Math.round(s));
      for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) this.b.set(X + dx, Y + dy, c);
    }

    rect(x, y, w, h, c) {
      const s = this.s;
      const X0 = Math.round(this.ox + x * s), Y0 = Math.round(this.oy + y * s);
      const X1 = Math.max(X0 + 1, Math.round(this.ox + (x + w) * s)), Y1 = Math.max(Y0 + 1, Math.round(this.oy + (y + h) * s));
      for (let yy = Y0; yy < Y1; yy++) for (let xx = X0; xx < X1; xx++) this.b.set(xx, yy, c);
    }

    line(x0, y0, x1, y1, c) {
      const s = this.s, n = Math.max(1, Math.round(s));
      let X0 = Math.floor(this.ox + x0 * s), Y0 = Math.floor(this.oy + y0 * s);
      const X1 = Math.floor(this.ox + x1 * s), Y1 = Math.floor(this.oy + y1 * s);
      const dx = Math.abs(X1 - X0), dy = -Math.abs(Y1 - Y0), sx = X0 < X1 ? 1 : -1, sy = Y0 < Y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) this.b.set(X0 + a, Y0 + b, c);
        if (X0 === X1 && Y0 === Y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; X0 += sx; }
        if (e2 <= dx) { err += dx; Y0 += sy; }
      }
    }
  }

  // =====================================================================
  // Реестр кадров и атлас
  // =====================================================================
  const entries = [];
  const sprites = Object.create(null);

  function frameFrom(buf, ax, ay, noOutline) {
    if (!noOutline) outline(buf);
    const f = { buf, ax, ay, x: 0, y: 0, w: buf.w, h: buf.h, fx: 0, fy: 0 };
    entries.push(f);
    return f;
  }

  /**
   * Создаёт кадры анимации. draw(painter, i) рисует i-й кадр.
   * s — масштаб: те же рисунки в крупном размере (элиты), пиксели остаются чёткими.
   */
  function anim(w, h, n, ax, ay, s, draw) {
    const W = Math.ceil(w * s), H = Math.ceil(h * s), out = [];
    for (let i = 0; i < n; i++) {
      const b = new PixelBuffer(W, H);
      draw(new Painter(b, s, 0, 0), i);
      out.push(frameFrom(b, ax * s, ay * s));
    }
    return out;
  }
  function raw(w, h, s, draw) {
    const b = new PixelBuffer(Math.ceil(w * s), Math.ceil(h * s));
    draw(new Painter(b, s, 0, 0));
    return b;
  }
  function define(name, anims, meta) {
    sprites[name] = Object.assign({ name, anims }, meta || {});
    return sprites[name];
  }

  function buildAtlas() {
    const W = 2048, PAD = 1;
    const list = entries.slice().sort((a, b) => b.h - a.h);
    let x = 0, y = 0, rowH = 0;
    for (const f of list) {
      const need = f.w * 2 + PAD * 2;
      if (x + need > W) { x = 0; y += rowH + PAD; rowH = 0; }
      f.x = x; f.y = y; f.fx = x + f.w + PAD; f.fy = y;
      x += need; if (f.h > rowH) rowH = f.h;
    }
    const H = y + rowH;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const out = new Uint32Array(img.data.buffer), rgba = P.rgba, white = rgba[WHITE], ink = rgba[INK];
    for (const f of list) {
      const src = f.buf.px;
      for (let j = 0; j < f.h; j++) {
        for (let i = 0; i < f.w; i++) {
          const v = src[j * f.w + i];
          if (!v) continue;
          out[(f.y + j) * W + f.x + i] = rgba[v];
          out[(f.fy + j) * W + f.fx + i] = v === INK ? ink : white;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // =====================================================================
  // Позы гуманоидов
  // =====================================================================
  const WALK = [
    { stride: 1, bob: 0, liftB: 0, liftF: 0 },
    { stride: 0, bob: -1, liftB: 1, liftF: 0 },
    { stride: -1, bob: 0, liftB: 0, liftF: 0 },
    { stride: 0, bob: -1, liftB: 0, liftF: 1 },
  ];
  const IDLE = [
    { stride: 0, bob: 0, liftB: 0, liftF: 0 },
    { stride: 0, bob: 0.6, liftB: 0, liftF: 0 },
  ];
  const HURT = { stride: 0.4, bob: 0, liftB: 0, liftF: 0, hurt: true };

  function legs(p, cx, pose, pants, boots, hipY, footY, r) {
    const s = pose.stride, b = pose.bob;
    hipY = hipY || 21; footY = footY || 29; r = r || 1.7;
    p.limb(cx - 1.6, hipY + b, cx - 1.6 - s * 3, footY - pose.liftB, r, pants, -0.25);
    p.blob(cx - 1 - s * 3, footY + 0.5 - pose.liftB, r + 0.7, 1.4, boots, -0.2);
    p.limb(cx + 1.6, hipY + b, cx + 1.6 + s * 3, footY - pose.liftF, r, pants);
    p.blob(cx + 2.2 + s * 3, footY + 0.5 - pose.liftF, r + 0.7, 1.4, boots);
  }
  function eyes(p, hx, hy, pose, color) {
    if (pose.hurt) { p.line(hx + 0.3, hy, hx + 1.3, hy, INK); p.line(hx + 2.3, hy, hx + 3.2, hy, INK); return; }
    p.px(hx + 0.6, hy - 0.5, color || INK);
    p.px(hx + 2.6, hy - 0.5, color || INK);
  }
  function arcPoints(cx, cy, rx, ry, a0, a1, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
    return pts;
  }
  function polyline(p, pts, r, ramp, bias) {
    for (let i = 0; i + 3 < pts.length; i += 2) p.limb(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], r, ramp, bias);
  }

  // =====================================================================
  // ГЕРОИ (32×32, ноги в y≈30)
  // =====================================================================
  const HERO_ART = {
    /** Ольгерд — пепельный рыцарь: шлем с плюмажем, щит, меч. */
    knight(p, pose) {
      const cx = 15, b = pose.bob, lean = pose.hurt ? -1 : 0;
      // щит за спиной/сбоку
      p.blob(cx - 5 + lean, 18 + b, 4.6, 5.6, R.steel, -0.1);
      p.blob(cx - 5 + lean, 18 + b, 3.4, 4.4, R.blue);
      p.blob(cx - 5.4 + lean, 17.4 + b, 1.2, 1.2, R.gold, 0.1);
      legs(p, cx, pose, R.steel, R.steel);
      p.limb(cx - 2 + lean, 14 + b, cx - 4 + lean, 19 + b, 1.5, R.steel, -0.3);
      p.blob(cx + lean, 17 + b, 5, 5.5, R.steel);
      p.poly([cx - 1 + lean, 13 + b, cx + 3 + lean, 13 + b, cx + 3.5 + lean, 23 + b, cx - 1.5 + lean, 23 + b], R.blue, 0, true);
      p.rect(cx - 4.5 + lean, 20.5 + b, 9, 1.2, R.gold[2]);
      p.px(cx + 1 + lean, 20.5 + b, R.gold[4]);
      // шлем
      const hx = cx + 1 + lean * 2, hy = 9 + b;
      p.limb(hx - 0.5, hy - 4.2, hx - 3.8, hy - 5, 1.4, R.red, 0.1);
      p.limb(hx - 3.8, hy - 5, hx - 6, hy - 1.5, 1.2, R.red);
      p.blob(hx, hy, 4.8, 4.6, R.steel, 0.05);
      p.line(hx + 0.5, hy + 0.3, hx + 4.5, hy + 0.3, INK);
      if (!pose.hurt) p.px(hx + 3, hy + 0.3, R.ice[3]);
      p.px(hx + 3, hy + 2, INK);
      // рука с мечом: pose.sword — положение кисти и угол клинка (удар), иначе меч поднят у плеча
      const sw = pose.sword || { hx: 5.5, hy: 19, a: -1.29, len: 12.5 };
      const hx2 = cx + sw.hx + lean, hy2 = sw.hy + b;
      p.limb(cx + 3 + lean, 14 + b, hx2, hy2, 1.5, R.steel);
      const c = Math.cos(sw.a), sn = Math.sin(sw.a), L = sw.len;
      p.limb(hx2 + c, hy2 + sn, hx2 + c * L, hy2 + sn * L, 1.0, R.steel, 0.15);
      p.line(hx2 + c * 2, hy2 + sn * 2, hx2 + c * (L - 1), hy2 + sn * (L - 1), R.steel[4]);
      p.limb(hx2 - sn * 2, hy2 + c * 2, hx2 + sn * 2, hy2 - c * 2, 0.8, R.gold);
      p.px(hx2 - c * 1.2, hy2 - sn * 1.2, R.gold[3]);
    },

    /** Мирра — ведьма пепла: остроконечная шляпа, мантия, посох с кристаллом. */
    witch(p, pose) {
      const cx = 15, b = pose.bob, s = pose.stride, lean = pose.hurt ? -1 : 0;
      p.limb(cx - 1 + lean, 9 + b, cx - 3.5 + lean, 19 + b, 2.4, R.bone, -0.1);
      p.blob(cx - 1.5 + s * 2, 29.5, 2, 1.2, R.dirt, -0.2);
      p.blob(cx + 2.5 - s * 2, 29.5, 2, 1.2, R.dirt);
      p.poly([cx - 3.5 + lean, 13 + b, cx + 3.5 + lean, 13 + b, cx + 6.5 + s, 29, cx - 6.5 + s, 29], R.purple);
      p.line(cx - 6 + s, 28.5, cx + 6 + s, 28.5, R.gold[2]);
      p.blob(cx + lean, 16 + b, 4, 4.5, R.purple, 0.05);
      p.rect(cx - 3.5 + lean, 19.5 + b, 7, 1, R.gold[2]);
      const hx = cx + 1 + lean * 2, hy = 10 + b;
      p.blob(hx, hy, 3.8, 3.8, R.skin);
      p.blob(hx - 1, hy - 2, 3.6, 2, R.bone, 0.1);
      eyes(p, hx, hy + 0.5, pose, R.purple[1]);
      // шляпа
      p.poly([hx - 4, hy - 3.2, hx + 4.6, hy - 3.2, hx + 0.5, hy - 7.5, hx - 4.5, hy - 9], R.purple, 0.05);
      p.blob(hx + 0.3, hy - 3, 6.8, 1.7, R.purple, -0.05);
      p.line(hx - 3.2, hy - 4.2, hx + 3.6, hy - 4.2, R.gold[3]);
      // посох: pose.staff — низ и верх посоха (каст), иначе стоит у ноги
      const st = pose.staff;
      const x0 = cx + (st ? st.x0 : 5.2), y0 = st ? st.y0 + b : 29, x1 = cx + (st ? st.x1 : 7), y1 = (st ? st.y1 : 5) + b;
      const ux = (x1 - x0) / Math.hypot(x1 - x0, y1 - y0), uy = (y1 - y0) / Math.hypot(x1 - x0, y1 - y0);
      p.limb(cx + 2.5 + lean, 13.5 + b, st ? x0 + (x1 - x0) * 0.5 : cx + 5.5, st ? y0 + (y1 - y0) * 0.5 : 17 + b, 1.4, R.purple);
      p.limb(x0, y0, x1, y1, 0.9, R.wood);
      const kx = x1 + ux * 1.4, ky = y1 + uy * 1.4, glow = st ? st.glow : 0;
      if (glow > 1) p.blob(kx, ky, 4, 4, R.ice, 0.5);
      p.blob(kx, ky, 2.4 + glow * 0.3, 2.4 + glow * 0.3, R.ice, 0.2 + glow * 0.1);
      p.px(kx - 1, ky - 1.2, WHITE);
      p.px(kx - 2.2, ky + 0.4, R.gold[3]); p.px(kx + 1.8, ky + 0.4, R.gold[3]);
      if (glow > 1) { p.px(kx + 4, ky - 3, WHITE); p.px(kx + 5, ky + 2, R.ice[4]); p.px(kx - 1, ky - 5, R.ice[4]); }
    },

    /** Ясна — охотница: капюшон, развевающийся плащ, колчан, лук. */
    huntress(p, pose) {
      const cx = 15, b = pose.bob, s = pose.stride, lean = pose.hurt ? -1 : 0;
      p.poly([cx - 2 + lean, 11 + b, cx + 2 + lean, 12 + b, cx - 3.5 - s * 1.5, 27, cx - 8.5 - s * 2, 25 + b], R.grass, -0.05);
      p.limb(cx - 4 + lean, 12 + b, cx - 2 + lean, 20 + b, 1.7, R.dirt, -0.1);
      p.px(cx - 4.8 + lean, 10.6 + b, R.red[3]); p.px(cx - 3.4 + lean, 10 + b, R.bone[3]);
      legs(p, cx, pose, R.dirt, R.wood);
      p.blob(cx + lean, 17 + b, 4.2, 5, R.dirt, 0.05);
      p.line(cx - 3 + lean, 13 + b, cx + 3 + lean, 20 + b, R.wood[1]);
      p.rect(cx - 4 + lean, 20 + b, 8, 1, R.wood[1]);
      const hx = cx + 0.6 + lean * 2, hy = 9 + b;
      p.limb(hx - 2, hy - 3.6, hx - 5.2, hy - 0.6, 1.3, R.grass);
      p.blob(hx, hy, 4.8, 4.8, R.grass, 0.05);
      p.blob(hx + 1.8, hy + 1, 2.8, 3, R.skin);
      eyes(p, hx + 1.2, hy + 1, pose);
      // лук: pose.bow — вынос вперёд и натяжение тетивы (выстрел)
      const bw = pose.bow || { dx: 0, pull: 0, arrow: false };
      const bx = cx + 6 + bw.dx + lean, sx = bx - 0.5 - bw.pull * 6, sy = 16 + b;
      p.limb(cx + 2.5 + lean, 14 + b, bx, 16 + b, 1.4, R.dirt);
      p.line(bx - 0.5, 6 + b, sx, sy, R.bone[3]);
      p.line(sx, sy, bx - 0.5, 26 + b, R.bone[3]);
      polyline(p, arcPoints(bx - 2.5, 16 + b, 5.8, 10, -1.25, 1.25, 8), 0.8, R.wood, 0.1);
      if (bw.arrow) { p.line(sx, sy, bx + 4, sy, R.wood[3]); p.px(bx + 4.5, sy, R.steel[4]); p.px(sx, sy - 1, R.red[3]); }
      if (bw.pull > 0) p.limb(cx + 1 + lean, 14 + b, sx, sy, 1.2, R.dirt);
      if (bw.snap) { p.px(bx - 1.5, 11 + b, R.bone[4]); p.px(bx + 0.5, 21 + b, R.bone[4]); }
    },

    /** Хорн — могильщик: широкополая шляпа, длинный плащ, лопата, фонарь. */
    gravedigger(p, pose) {
      const cx = 15, b = pose.bob, s = pose.stride, lean = pose.hurt ? -1 : 0;
      p.limb(cx + 3 + lean, 9 + b, cx - 7 + lean, 24 + b, 0.9, R.wood);
      p.poly([cx - 10 + lean, 22.5 + b, cx - 6 + lean, 23.5 + b, cx - 6.8 + lean, 28.5 + b, cx - 10.8 + lean, 27.5 + b], R.steel, 0.05);
      legs(p, cx, pose, R.night, R.wood, 22, 29, 1.9);
      p.poly([cx - 5 + lean, 12 + b, cx + 5 + lean, 12 + b, cx + 6.5 + s, 27, cx - 6.5 + s, 27], R.stone, -0.15);
      p.blob(cx + lean, 16 + b, 5.6, 5, R.stone, -0.05);
      p.px(cx + 1.5 + lean, 15 + b, R.gold[3]); p.px(cx + 1.5 + lean, 18 + b, R.gold[3]);
      p.rect(cx - 5 + lean, 20 + b, 10, 1, R.wood[1]);
      const hx = cx + 1 + lean * 2, hy = 10 + b;
      p.blob(hx, hy, 3.9, 3.8, R.skin, -0.05);
      p.blob(hx + 1.2, hy + 2.6, 3, 1.8, R.stone, 0.15);
      eyes(p, hx, hy, pose);
      p.blob(hx + 0.3, hy - 4.6, 4.2, 3, R.wood, 0.05, undefined, hy - 3);
      p.blob(hx + 0.3, hy - 3, 7.6, 1.8, R.wood, -0.05);
      p.line(hx - 3.6, hy - 3.8, hx + 4, hy - 3.8, R.red[2]);
      // фонарь: pose.lamp — фонарь поднят (волна света), flare — вспышка
      const lm = pose.lamp;
      const lx = cx + (lm ? lm.x : 6.5) + lean, ly = (lm ? lm.y : 19) + b, fl = lm ? lm.flare : 0;
      p.limb(cx + 3 + lean, 14 + b, lx - 0.5, ly, 1.6, R.stone);
      if (fl) p.blob(lx, ly + 3.6, 4.5, 4.5, R.fire, 0.6);
      p.rect(lx - 1.5, ly + 0.5, 3, 1, R.gold[2]);
      p.blob(lx, ly + 3.6, 2 + fl * 0.4, 2.6 + fl * 0.4, R.fire, 0.35 + fl * 0.15);
      p.px(lx - 0.5, ly + 3, fl ? WHITE : R.fire[4]);
      p.rect(lx - 1.5, ly + 6, 3, 1, R.gold[1]);
      if (fl > 1) for (const [a, r] of [[-2.4, 7], [-1.57, 8], [-0.7, 7], [0, 6.5], [3.14, 6.5]]) p.px(lx + Math.cos(a) * r, ly + 3.6 + Math.sin(a) * r, R.gold[4]);
    },
  };

  function buildHero(name) {
    const art = HERO_ART[name];
    const idle = anim(32, 32, 2, 16, 30, 1, (p, i) => art(p, IDLE[i]));
    const walk = anim(32, 32, 4, 16, 30, 1, (p, i) => art(p, WALK[i]));
    const hurt = anim(32, 32, 1, 16, 30, 1, (p) => art(p, HURT));
    // смерть — поворот кадра «ранен» и падение назад
    const base = raw(32, 32, 1, (p) => art(p, HURT));
    const death = [];
    const angles = [-0.3, -0.75, -1.2, -1.57];
    for (let i = 0; i < 4; i++) {
      const rb = rotateBuffer(base, angles[i], 16, 30, 48, 46, 32, 36);
      death.push(frameFrom(rb, 32, 36));
    }
    const anims = { idle, walk, hurt, death };
    // удар мечом: замах → удар → проводка; кадр шире и выше (40×38, рисунок сдвинут на 6 вниз),
    // чтобы клинок над головой и впереди не обрезался
    if (HERO_ACTS[name]) {
      const { key, frames: sw } = HERO_ACTS[name], OY = 6;
      const tall = (n, pose) => {
        const out = [];
        for (let i = 0; i < n; i++) {
          const b = new PixelBuffer(40, 32 + OY);
          art(new Painter(b, 1, 0, OY), pose(i));
          out.push(frameFrom(b, 16, 30 + OY));
        }
        return out;
      };
      anims.attack = tall(sw.length, (i) => Object.assign({}, IDLE[0], { [key]: sw[i] }));
      // те же фазы на ходу: 3 фазы × 4 шага
      anims.attackWalk = tall(sw.length * 4, (i) => Object.assign({}, WALK[i % 4], { [key]: sw[(i / 4) | 0] }));
    }
    define('hero_' + name, anims);
  }
  // Атака героя: 3 фазы (подготовка → действие → возврат). key — поле позы, которое читает HERO_ART.
  const HERO_ACTS = {
    knight: { key: 'sword', frames: [
      { hx: 5, hy: 8, a: -2.35, len: 12.5 },   // замах: меч занесён над головой назад
      { hx: 7.5, hy: 15, a: -0.15, len: 13 },  // удар вперёд
      { hx: 6, hy: 20, a: 0.75, len: 12.5 },   // проводка вниз
    ] },
    witch: { key: 'staff', frames: [
      { x0: 3, y0: 28, x1: 4, y1: 3, glow: 0.5 },    // посох отведён назад, кристалл разгорается
      { x0: 2, y0: 23, x1: 15, y1: 7, glow: 2 },     // выпад вперёд — вспышка
      { x0: 4.5, y0: 28.5, x1: 9.5, y1: 4, glow: 1 },
    ] },
    huntress: { key: 'bow', frames: [
      { dx: 2, pull: 0.3, arrow: true },             // вскинула лук
      { dx: 3, pull: 1, arrow: true },               // натянула
      { dx: 3, pull: 0, arrow: false, snap: true },  // выстрел, тетива дрожит
    ] },
    gravedigger: { key: 'lamp', frames: [
      { x: 7, y: 11, flare: 0 },                     // поднимает фонарь
      { x: 5.5, y: 1, flare: 2 },                    // над головой — вспышка
      { x: 7, y: 12, flare: 1 },
    ] },
  };

  // =====================================================================
  // МОБЫ
  // =====================================================================
  const MOB_ART = {
    /** Гнилец — сгорбленный мертвец с протянутыми руками. */
    ghoul(p, i) {
      const pose = WALK[i], cx = 15, b = pose.bob, sw = [0, 1, 0, -1][i];
      p.limb(cx + 1, 15 + b, cx + 7, 17 + b + sw, 1.3, R.ghoul, -0.3);
      legs(p, cx - 1, pose, R.dirt, R.ghoul, 21, 29, 1.5);
      p.blob(cx - 1, 18 + b, 4.6, 5, R.ghoul);
      p.poly([cx - 5.5, 15 + b, cx + 3, 15 + b, cx + 3, 23 + b, cx + 1.5, 21.5 + b, cx, 24 + b, cx - 2, 22 + b, cx - 3.5, 24 + b, cx - 5.5, 22 + b], R.dirt, -0.05);
      const hx = cx + 3, hy = 13 + b;
      p.blob(hx, hy, 3.6, 3.4, R.ghoul, 0.05);
      p.px(hx + 0.4, hy - 0.6, R.toxic[4]); p.px(hx + 2.4, hy - 0.6, R.toxic[4]);
      p.line(hx + 0.5, hy + 1.6, hx + 2.6, hy + 1.6, INK);
      p.limb(cx + 2, 16 + b, cx + 8, 18 + b - sw, 1.4, R.ghoul);
      p.px(cx + 8.5, 18 + b - sw, R.bone[2]);
    },

    /** Нетопырь — летучая мышь с перепончатыми крыльями. */
    bat(p, i) {
      const cx = 16, cy = 13, ty = [-7, -3, 4, -2][i];
      for (const side of [-1, 1]) {
        const tip = cx + side * 13;
        p.poly([cx + side * 2, cy - 1, tip, cy + ty - 2, cx + side * 10, cy + ty * 0.4 + 3, cx + side * 6, cy + 2, cx + side * 3, cy + 4], R.purple, -0.25);
        p.line(cx + side * 2, cy - 1, tip, cy + ty - 2, R.purple[3]);
        p.line(cx + side * 6, cy + ty * 0.5, cx + side * 6, cy + 2, R.purple[1]);
      }
      p.blob(cx, cy + 1, 3.5, 4, R.purple, 0.05);
      p.blob(cx, cy - 3, 2.8, 2.6, R.purple, 0.1);
      p.limb(cx - 1.6, cy - 4.5, cx - 2.6, cy - 7.5, 0.8, R.purple);
      p.limb(cx + 1.6, cy - 4.5, cx + 2.6, cy - 7.5, 0.8, R.purple);
      p.px(cx - 1.4, cy - 3, R.red[4]); p.px(cx + 0.8, cy - 3, R.red[4]);
      p.px(cx - 0.5, cy - 1, R.bone[3]);
    },

    /** Пепельная гончая — тощий волк с тлеющими углями на спине. */
    hound(p, i, crouch) {
      const b = crouch ? 2 : [0, -1, 0, -1][i], g = crouch ? 0 : [2.5, 0, -2.5, 0][i];
      p.limb(8, 17 + b, 3, 13 + (i % 2) * 2, 1.3, R.stone, -0.3);
      p.limb(9, 21 + b, 9 - g, 29, 1.2, R.stone, -0.5);
      p.limb(21, 21 + b, 21 + g + (crouch ? 3 : 0), 29, 1.2, R.stone, -0.5);
      p.blob(14.5, 19 + b, 8, 4.2, R.stone, -0.3);
      p.blob(20, 18 + b, 4, 4.5, R.stone, -0.2);
      p.limb(11, 21 + b, 11 + g, 29, 1.3, R.stone, -0.2);
      p.limb(23, 21 + b, 23 - g + (crouch ? 3 : 0), 29, 1.3, R.stone, -0.2);
      const hb = crouch ? 2 : b;
      p.limb(23, 11 + hb, 22, 9 + hb, 1.1, R.stone, -0.2);
      p.limb(25.5, 11 + hb, 26, 9.5 + hb, 1.1, R.stone, -0.1);
      p.blob(24.5, 14 + hb, 3.8, 3.4, R.stone, -0.15);
      p.limb(26, 15 + hb, 29.5, 16 + hb, 1.7, R.stone, -0.2);
      p.px(29.6, 15 + hb, INK);
      p.line(26.5, 17 + hb, 29.5, 17 + hb, INK);
      p.px(26, 13.4 + hb, R.red[4]);
      p.px(12, 15.5 + b, R.fire[3]); p.px(15, 15 + b, R.fire[2]); p.px(18, 15 + b, R.fire[3]);
    },

    /** Скелет-лучник — костлявый стрелок в обрывке лилового капюшона. */
    archer(p, i, drawn) {
      const pose = WALK[i], cx = 15, b = pose.bob;
      legs(p, cx, pose, R.bone, R.bone, 21, 29, 1.1);
      p.blob(cx, 21 + b, 3, 1.8, R.bone);
      p.limb(cx - 1.5, 14 + b, cx - 3.5, 19 + b, 1, R.bone, -0.3);
      p.limb(cx, 14 + b, cx, 21 + b, 0.9, R.bone);
      p.blob(cx, 16.5 + b, 3.6, 3.6, R.bone);
      for (let k = 0; k < 3; k++) p.line(cx - 2.5, 15 + b + k * 1.6, cx + 2.5, 15 + b + k * 1.6, R.bone[0]);
      const hx = cx + 1, hy = 9.5 + b;
      p.blob(hx, hy, 3.8, 3.6, R.bone, 0.05);
      p.blob(hx - 0.5, hy - 2.2, 4.2, 2.2, R.purple, -0.05, undefined, hy - 1);
      p.rect(hx + 0.2, hy - 0.4, 1.4, 1.4, INK); p.rect(hx + 2.4, hy - 0.4, 1.4, 1.4, INK);
      p.px(hx + 0.6, hy, R.red[4]); p.px(hx + 2.8, hy, R.red[4]);
      p.line(hx + 0.6, hy + 2.4, hx + 3, hy + 2.4, R.bone[0]);
      const bx = cx + 6;
      p.limb(cx + 2, 14 + b, bx, 16 + b, 1, R.bone);
      const pull = drawn ? 3 : 0;
      p.line(bx - 0.5, 8 + b, bx - 0.5 - pull, 16 + b, R.bone[3]);
      p.line(bx - 0.5 - pull, 16 + b, bx - 0.5, 24 + b, R.bone[3]);
      if (drawn) p.line(bx - 3, 16 + b, bx + 5, 16 + b, R.bone[2]);
      polyline(p, arcPoints(bx - 2, 16 + b, 4.8, 8, -1.2, 1.2, 7), 0.75, R.wood, 0.1);
    },

    /** Чумной слизень — пульсирующая капля с черепом внутри. */
    slime(p, i) {
      const rx = [7, 6.4, 7.8, 6.8][i], ry = [5.6, 6.3, 4.8, 5.8][i], cx = 16, cy = 29.5 - ry;
      p.blob(cx, cy, rx, ry, R.toxic, -0.05);
      p.blob(cx + 0.5, cy + 1, 2, 1.8, R.bone, -0.25);
      p.px(cx, cy + 0.8, R.toxic[1]); p.px(cx + 1.4, cy + 0.8, R.toxic[1]);
      p.blob(cx - rx * 0.45, cy - ry * 0.5, 1.6, 1, R.toxic, 0.6);
      p.px(cx + 2, cy - 2, INK); p.px(cx + 4.2, cy - 2, INK);
      p.px(cx + 2, cy - 3, WHITE); p.px(cx + 4.2, cy - 3, WHITE);
      p.px(cx - 3, cy + 2, R.toxic[4]); p.px(cx + 4, cy + 3, R.toxic[3]);
    },

    /** Курганный голем — каменная громада с мхом и тлеющими трещинами (32×48). */
    golem(p, i) {
      const pose = WALK[i], s = pose.stride, b = pose.bob;
      p.limb(11.5, 34 + b, 11 - s * 2, 44 - pose.liftB, 3, R.stone, -0.25);
      p.blob(10.5 - s * 2, 45, 4, 2, R.stone, -0.2);
      p.limb(7, 22 + b, 5.5, 35 - s * 1.5 + b, 3, R.stone, -0.3);
      p.blob(5.5, 36 - s * 1.5 + b, 3.4, 3, R.stone, -0.2);
      p.limb(20.5, 34 + b, 21 + s * 2, 44 - pose.liftF, 3.2, R.stone);
      p.blob(21.5 + s * 2, 45, 4.2, 2, R.stone);
      p.blob(16, 26 + b, 10, 9.5, R.stone);
      p.blob(15, 19 + b, 7, 2, R.grass, 0.1, undefined, 20 + b);
      p.line(13, 24 + b, 15, 27 + b, R.fire[3]); p.line(15, 27 + b, 14, 30 + b, R.fire[2]);
      p.line(19, 25 + b, 20, 28 + b, R.fire[2]);
      p.blob(17, 14 + b, 5, 4.4, R.stone, 0.05);
      p.rect(17, 13 + b, 1.4, 1.2, R.fire[4]); p.rect(19.8, 13 + b, 1.4, 1.2, R.fire[4]);
      p.blob(7, 20 + b, 4.6, 4, R.stone, 0.05);
      p.blob(26, 20 + b, 4.6, 4, R.stone, 0.05);
      p.blob(25, 17.5 + b, 2.6, 1, R.grass, 0.15);
      p.limb(26, 23 + b, 27.5, 35 + s * 1.5 + b, 3.2, R.stone);
      p.blob(27.5, 36 + s * 1.5 + b, 3.6, 3.2, R.stone, 0.05);
    },

    /** Блуждающий дух — полупрозрачное покрывало с пустыми глазницами. */
    ghost(p, i) {
      const b = [0, -1, -1, 0][i], w = [0, 1, 2, 1][i], cx = 16;
      p.poly([cx - 6.5, 12 + b, cx + 6.5, 12 + b, cx + 7.5, 25 + b, cx + 5, 23 + b + w * 0.5, cx + 3, 26 + b - w * 0.5, cx + 0.5, 23 + b + w * 0.5,
        cx - 2, 26 + b - w * 0.3, cx - 4.5, 23 + b, cx - 7.5, 25 + b + w * 0.3], R.ice, -0.05);
      p.blob(cx, 11 + b, 6.5, 6.5, R.ice, 0.05);
      p.limb(cx + 5, 15 + b, cx + 9, 18 + b - w, 1.3, R.ice);
      p.blob(cx - 0.5, 10.5 + b, 1.3, 2, R.night, -0.5);
      p.blob(cx + 3, 10.5 + b, 1.3, 2, R.night, -0.5);
      p.blob(cx + 1.3, 15 + b, 1.2, 1.5 + w * 0.2, R.night, -0.5);
    },

    /** Бес-подрывник — краснокожий чертёнок с раскалённым брюхом. */
    imp(p, i, lit) {
      const pose = WALK[i], cx = 15, b = pose.bob, body = lit ? R.fire : R.red;
      p.limb(cx - 3, 22 + b, cx - 8, 24 + b + (i % 2), 0.9, R.red, -0.2);
      p.px(cx - 9, 23.5 + b + (i % 2), R.red[3]);
      legs(p, cx, pose, R.red, R.night, 22, 29, 1.3);
      p.blob(cx, 20.5 + b, 4, 4.4, body);
      p.blob(cx + 0.8, 21.5 + b, 2.2, 2.4, R.fire, lit ? 0.6 : 0.3);
      const hx = cx + 1.5, hy = 13 + b;
      p.limb(hx - 1.5, hy - 2, hx - 3.5, hy - 6, 1, R.bone);
      p.limb(hx + 1.5, hy - 2, hx + 3, hy - 6, 1, R.bone, 0.1);
      p.blob(hx, hy, 3.8, 3.5, body, 0.05);
      p.px(hx - 0.2, hy - 0.5, R.gold[4]); p.px(hx + 2, hy - 0.5, R.gold[4]);
      p.line(hx - 0.5, hy + 1.6, hx + 2.6, hy + 1.6, INK);
      p.limb(cx + 2.5, 18 + b, cx + 6, 20 + b, 1, body);
    },
  };

  function buildMob(name, w, h, ax, ay, extra) {
    const art = MOB_ART[name];
    for (const variant of [['', 1], ['_elite', 1.4]]) {
      const s = variant[1];
      const anims = { walk: anim(w, h, 4, ax, ay, s, (p, i) => art(p, i, false)) };
      if (extra) anims[extra] = anim(w, h, 2, ax, ay, s, (p, i) => art(p, i * 2, true));
      define(name + variant[0], anims);
    }
  }

  // =====================================================================
  // БОССЫ
  // =====================================================================
  function rotPts(pts, ox, oy, a) {
    const c = Math.cos(a), s = Math.sin(a), out = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] - ox, y = pts[i + 1] - oy;
      out.push(ox + x * c - y * s, oy + x * s + y * c);
    }
    return out;
  }

  const BOSS_ART = {
    /** Мор, Костяной Жнец — парящий скелет-король в рваной мантии с косой (80×80). */
    reaper(p, i, attack) {
      const b = [0, -1, -2, -1][i], w = [0, 1, 2, 1][i];
      const swing = attack === 1 ? -0.9 : attack === 2 ? 0.8 : 0;
      // коса за спиной (держится правой рукой)
      const hx = 60, hy = 40 + b;
      const handle = rotPts([62, 72, 58, 10], hx, hy, swing);
      const blade = rotPts([58, 10, 70, 11, 77, 19, 78, 28, 72, 20, 64, 15, 57, 14], hx, hy, swing);
      p.limb(handle[0], handle[1], handle[2], handle[3], 1.4, R.wood, -0.05);
      p.poly(blade, R.steel, 0.1, true);
      const edge = rotPts([64, 12, 76, 21], hx, hy, swing);
      p.line(edge[0], edge[1], edge[2], edge[3], R.steel[4]);
      // мантия
      p.poly([28, 30 + b, 52, 30 + b, 60, 66 + b, 56, 71 + w + b, 52, 66 + b, 48, 72 - w + b, 44, 67 + b, 40, 73 + w + b,
        36, 67 + b, 32, 72 - w + b, 28, 66 + b, 23, 71 + w + b, 20, 66 + b], R.purple, -0.2);
      p.line(40, 34 + b, 40, 64 + b, R.purple[0]);
      p.line(33, 40 + b, 30, 62 + b, R.purple[1]);
      p.line(47, 40 + b, 50, 62 + b, R.purple[1]);
      p.rect(31, 44 + b, 18, 2, R.gold[2]);
      p.px(40, 44 + b, R.red[3]);
      p.blob(26, 36 + b, 5, 6, R.purple, -0.1);
      p.limb(25, 40 + b, 23, 50 + b, 1.4, R.bone, -0.2);
      // капюшон и череп
      p.blob(40, 22 + b, 11, 11, R.purple, 0.05);
      p.blob(42, 24 + b, 7, 7.5, R.night, -0.6);
      p.blob(43, 24.5 + b, 4.8, 5.2, R.bone, 0.05);
      p.rect(40.4, 23 + b, 2, 2, INK); p.rect(44, 23 + b, 2, 2, INK);
      p.px(41, 23.5 + b, R.red[4]); p.px(44.6, 23.5 + b, R.red[4]);
      for (let k = 0; k < 4; k++) p.px(41 + k * 1.2, 28 + b, k % 2 ? INK : R.bone[1]);
      p.poly([31, 14 + b, 49, 14 + b, 48, 9 + b, 45, 12 + b, 40, 6 + b, 35, 12 + b, 32, 9 + b], R.gold, 0.1);
      p.px(40, 10 + b, R.red[4]);
      // рука на косе
      p.blob(54, 35 + b, 5, 5.5, R.purple, -0.05);
      const hand = rotPts([60, 40], hx, hy, 0);
      p.limb(55, 38 + b, hand[0], hand[1], 1.5, R.bone);
    },

    /** Королева Роя — гигантская паучиха с пульсирующим брюшком (96×80). */
    queen(p, i, attack) {
      const rear = attack ? -6 : 0;
      const leg = (hx, hy, kx, ky, fx, fy, bias) => {
        p.limb(hx, hy, kx, ky, 1.8, R.purple, bias);
        p.limb(kx, ky, fx, fy, 1.4, R.purple, bias);
        p.px(fx, fy, R.bone[2]);
      };
      const ph = [0, 1, 0, -1];
      // дальние лапы
      for (let k = 0; k < 4; k++) {
        const o = ph[(i + k) % 4] * 2, dir = k - 1.5, up = k === 3 ? rear : 0;
        leg(52 + k * 3, 40, 54 + dir * 14 + o, 22 + Math.abs(dir) * 3 + up, 54 + dir * 24 + o, 58 + up, -0.35);
      }
      // брюшко
      p.blob(28, 44, 22, 17, R.purple, -0.05);
      p.blob(26, 38, 9, 5, R.toxic, 0.05);
      p.blob(27, 47, 5, 3, R.toxic, -0.1);
      for (let k = 0; k < 6; k++) p.px(14 + k * 5, 52 + (k % 2) * 3, R.toxic[4]);
      p.line(12, 44, 44, 44, R.purple[1]);
      // грудь и голова
      p.blob(55, 46 + rear * 0.5, 11, 10, R.purple, 0.05);
      const hy = 46 + rear;
      p.blob(69, hy, 9, 8, R.purple, 0.1);
      const eyesPos = [[70, hy - 3], [73, hy - 3.5], [76, hy - 2], [72, hy - 1], [75, hy + 0.5], [69.5, hy], [77.5, hy - 4.5]];
      for (const e of eyesPos) { p.px(e[0], e[1], R.red[4]); p.px(e[0] + 0.9, e[1] + 0.9, R.red[2]); }
      p.limb(75, hy + 5, 83, hy + 9 - (i % 2), 1.3, R.bone);
      p.limb(83, hy + 9 - (i % 2), 81, hy + 13, 1, R.bone, -0.1);
      p.limb(73, hy + 6, 77, hy + 12 + (i % 2), 1.1, R.bone, -0.2);
      // ближние лапы
      for (let k = 0; k < 4; k++) {
        const o = ph[(i + k + 2) % 4] * 2, dir = k - 1.5, up = k === 3 ? rear * 1.5 : 0;
        leg(50 + k * 4, 52, 52 + dir * 16 + o, 34 + Math.abs(dir) * 2 + up, 52 + dir * 27 + o, 75 + (k === 3 ? rear : 0), 0);
      }
    },

    /** Ашгар, Пламя Бездны — рогатый демон-дракон с огненной гривой (96×96). */
    ashgar(p, i, attack) {
      const flap = attack ? -10 : [0, -4, -7, -4][i], b = [0, -1, 0, 1][i];
      for (const side of [-1, 1]) {
        const sx = 48 + side * 8, tip = 48 + side * 46;
        p.poly([sx, 34 + b, tip, 14 + flap, 48 + side * 40, 40 + flap * 0.5, 48 + side * 32, 36, 48 + side * 26, 52, 48 + side * 16, 46], R.night, side < 0 ? -0.1 : 0.05);
        p.limb(sx, 34 + b, tip, 14 + flap, 1.6, R.red, -0.1);
        p.limb(48 + side * 30, 22 + flap * 0.6, 48 + side * 32, 36, 1, R.red, -0.2);
        p.limb(48 + side * 38, 18 + flap * 0.8, 48 + side * 40, 40 + flap * 0.5, 1, R.red, -0.2);
      }
      // хвост
      polyline(p, [40, 72, 28, 80, 16, 82 + (i % 2), 8, 78], 3, R.red, -0.2);
      p.blob(7, 77, 3, 3.5, R.fire, 0.3);
      // ноги
      const st = [2, 0, -2, 0][i];
      p.limb(40, 66, 37 - st, 88, 4.5, R.red, -0.25);
      p.blob(36 - st, 90, 6, 3, R.red, -0.2);
      p.limb(56, 66, 59 + st, 88, 4.8, R.red);
      p.blob(60 + st, 90, 6, 3, R.red);
      // тело
      p.blob(48, 58 + b, 15, 16, R.red);
      for (let k = 0; k < 4; k++) p.blob(50, 50 + k * 5.5 + b, 7 - k * 0.6, 2.2, R.gold, -0.05);
      p.line(44, 52 + b, 42, 60 + b, R.fire[3]);
      // руки
      p.limb(36, 46 + b, 28, 60 + b, 3.2, R.red, -0.25);
      p.limb(60, 46 + b, 68, 58 + b, 3.4, R.red);
      for (let k = 0; k < 3; k++) p.limb(68 + k, 58 + b, 70 + k * 1.5, 63 + b, 0.8, R.bone);
      // грива и голова
      for (let k = 0; k < 7; k++) p.blob(38 + k * 3.5, 36 + (k % 2) * 2 + b, 4, 4.5, R.fire, 0.1 + (i + k) % 3 * 0.08);
      const hx = 50, hy = 28 + b;
      p.limb(hx - 4, hy - 4, hx - 12, hy - 14, 2, R.bone);
      p.limb(hx - 12, hy - 14, hx - 10, hy - 20, 1.2, R.bone, 0.1);
      p.limb(hx + 4, hy - 4, hx + 10, hy - 15, 2, R.bone, 0.1);
      p.limb(hx + 10, hy - 15, hx + 8, hy - 21, 1.2, R.bone, 0.15);
      p.blob(hx, hy, 9, 8, R.red, 0.05);
      p.limb(hx + 4, hy + 3, hx + 12, hy + 5, 3.4, R.red, 0.05);
      p.rect(hx - 4, hy - 2, 3, 2, R.fire[4]); p.rect(hx + 2, hy - 2, 3, 2, R.fire[4]);
      if (attack) p.blob(hx + 10, hy + 7, 3, 2, R.fire, 0.5);
      else p.line(hx + 4, hy + 6, hx + 14, hy + 6, INK);
    },
  };

  function buildBoss(name, w, h, ax, ay) {
    const art = BOSS_ART[name];
    define(name, {
      walk: anim(w, h, 4, ax, ay, 1, (p, i) => art(p, i, 0)),
      attack: anim(w, h, 2, ax, ay, 1, (p, i) => art(p, i * 2, i + 1)),
    });
  }

  // =====================================================================
  // ДЕКОРАЦИИ (сортируются по Y вместе с персонажами)
  // =====================================================================
  function leafNoise(p, cx, cy, rx, ry, seed) {
    const rng = makeRng(seed);
    for (let k = 0; k < rx * ry * 0.5; k++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng());
      const x = cx + Math.cos(a) * rx * d * 0.9, y = cy + Math.sin(a) * ry * d * 0.9;
      const lit = (x - cx) / rx + (y - cy) / ry < -0.3;
      p.px(x, y, lit ? R.grass[4] : R.grass[rng() < 0.5 ? 1 : 0]);
    }
  }

  const DECOR_ART = {
    oak(p) {
      p.blob(22, 59, 6, 2, R.wood, -0.2);
      p.limb(24, 58, 24, 36, 3.5, R.wood);
      p.limb(24, 42, 15, 32, 1.6, R.wood, -0.1);
      p.limb(24, 40, 32, 31, 1.6, R.wood);
      p.line(23, 56, 23, 44, R.wood[0]); p.line(26, 52, 26, 46, R.wood[3]);
      p.blob(13, 30, 10, 8.5, R.grass, -0.3);
      p.blob(35, 30, 10, 8.5, R.grass, -0.25);
      p.blob(24, 24, 15, 12, R.grass, -0.05);
      p.blob(20, 15, 10, 8, R.grass, 0.12);
      p.blob(31, 19, 8, 7, R.grass, 0.02);
      leafNoise(p, 24, 24, 20, 16, 11);
    },
    pine(p) {
      p.limb(16, 54, 16, 44, 2.2, R.wood);
      const tiers = [[44, 13], [35, 11], [26, 8.5], [17, 6]];
      for (let k = 0; k < tiers.length; k++) {
        const [y, w] = tiers[k];
        p.poly([16, y - 14, 16 + w, y, 16 + w * 0.5, y - 1.5, 16, y + 1, 16 - w * 0.5, y - 1.5, 16 - w, y], R.grass, -0.15 + k * 0.06);
        p.line(16 - w * 0.6, y - 2, 16 - 1, y - 11, R.grass[3]);
      }
    },
    /** Ель: высокая, узкая, с поникшими ярусами — темнее сосны. */
    spruce(p) {
      p.limb(15, 62, 15, 54, 2, R.wood);
      p.blob(15, 62, 5, 1.6, R.wood, -0.3);
      const tiers = [[56, 12.5], [49, 11], [42, 9.5], [35, 8], [28, 6.5], [21, 5], [14, 3.5]];
      for (let k = 0; k < tiers.length; k++) {
        const [y, w] = tiers[k];
        p.poly([15, y - 11, 15 + w * 0.55, y - 5, 15 + w, y + 1, 15 + w * 0.45, y - 0.5, 15, y + 1.5, 15 - w * 0.45, y - 0.5, 15 - w, y + 1, 15 - w * 0.55, y - 5], R.grass, -0.32 + k * 0.05);
        p.line(15 - w * 0.75, y - 1, 15 - 1, y - 9, R.grass[2]);
        p.px(15 + w * 0.8, y, R.grass[0]);
      }
      p.limb(15, 4, 15, 1, 0.6, R.grass, 0.1);
    },
    deadtree(p) {
      p.blob(20, 53, 6, 2, R.wood, -0.3);
      p.limb(20, 53, 19, 26, 3, R.wood, -0.1);
      p.limb(19, 34, 9, 22, 1.6, R.wood, -0.15);
      p.limb(9, 22, 6, 14, 1, R.wood, -0.15);
      p.limb(19, 30, 30, 18, 1.6, R.wood);
      p.limb(30, 18, 34, 10, 1, R.wood);
      p.limb(30, 18, 36, 19, 0.8, R.wood);
      p.limb(19, 26, 20, 12, 1.4, R.wood, 0.05);
      p.limb(20, 12, 16, 5, 0.9, R.wood);
      p.line(18, 50, 18, 36, R.wood[0]);
    },
    bush(p) {
      p.blob(8, 13, 6, 5, R.grass, -0.2);
      p.blob(20, 13, 6.5, 5, R.grass, -0.1);
      p.blob(14, 10, 8, 6, R.grass, 0.05);
      leafNoise(p, 14, 11, 10, 6, 5);
      p.px(10, 9, R.red[3]); p.px(17, 12, R.red[3]); p.px(20, 8, R.red[4]); p.px(12, 14, R.red[2]);
    },
    rock_s(p) {
      p.blob(8, 8, 6.5, 4.5, R.stone, -0.05);
      p.line(6, 6, 9, 9, R.stone[1]);
      p.px(5, 5, R.grass[3]);
    },
    rock_m(p) {
      p.blob(14, 14, 11, 7, R.stone, -0.1);
      p.blob(11, 10.5, 7, 5, R.stone, 0.1);
      p.line(14, 8, 17, 15, R.stone[1]); p.line(17, 15, 21, 16, R.stone[1]);
      p.blob(9, 7.5, 3.5, 1.3, R.grass, 0.15);
    },
    /** Скальный выступ: светлая верхняя грань, тёмный обрыв, осыпь. */
    outcrop(p) {
      const top = [6, 18, 14, 9, 30, 6, 46, 8, 58, 15, 60, 26, 48, 30, 30, 31, 12, 29, 5, 25];
      const wall = [5, 25, 12, 29, 30, 31, 48, 30, 60, 26, 59, 44, 52, 50, 36, 52, 18, 51, 7, 45];
      p.poly(wall, R.stone, -0.45, true);
      for (const x of [12, 19, 27, 35, 43, 51]) p.line(x, 31, x + (x % 3) - 1, 49, R.stone[0]);
      for (const x of [15, 31, 46]) p.line(x + 2, 32, x + 2, 42, R.stone[2]);
      p.poly(top, R.stone, 0.1, true);
      p.blob(26, 14, 12, 4, R.grass, 0.05);
      p.blob(44, 18, 7, 3, R.grass, 0);
      leafNoise(p, 30, 15, 16, 5, 9);
      p.line(8, 23, 30, 30, R.stone[4]);
      for (let k = 0; k < 6; k++) p.blob(8 + k * 9, 51 + (k % 2), 2.5, 1.8, R.stone, -0.1);
    },
    /** Обломанная колонна древнего храма. */
    pillar(p) {
      p.face(3, 41, 14, 4, R.stone, 0.55, 0.2, 0.2);
      p.face(3, 44, 14, 3, R.stone, 0.25, 0.15, 0.1);
      p.limb(10, 40, 10, 12, 5, R.stone, 0.05);
      for (const x of [7, 10, 13]) p.line(x, 14, x, 39, x === 7 ? R.stone[4] : R.stone[1]);
      p.poly([4, 13, 16, 13, 15, 9, 12, 11, 10, 6, 7, 10, 5, 8], R.stone, 0.2, true);
      p.line(12, 22, 11, 27, INK); p.line(11, 27, 13, 30, INK);
      p.blob(7, 38, 3, 2, R.grass, 0.1); p.blob(13, 12, 2.5, 1.2, R.grass, 0.15);
    },
    /** Разрушенная стена из кладки. */
    ruinwall(p) {
      const tops = [10, 7, 12, 9, 14, 11];
      for (let c = 0; c < 6; c++) {
        const x = 2 + c * 7.4, t = tops[c];
        for (let y = t; y < 31; y += 4) {
          const off = ((y - t) / 4) % 2 ? 3.7 : 0;
          for (let bx = 0; bx < 2; bx++) {
            const xx = x + bx * 3.7 - off * 0;
            if (xx > 46) continue;
            p.face(xx, y, 3.3, 3.4, R.stone, 0.6 - (y - t) * 0.012, 0.25, 0.3);
            p.line(xx, y, xx + 3, y, R.stone[4]);
          }
        }
        p.face(x, t - 2, 7.4, 2, R.stone, 0.85, 0.2, 0);
      }
      p.face(2, 31, 44, 3, R.stone, 0.2, 0.1, 0);
      p.blob(10, 7, 4, 1.6, R.grass, 0.1); p.blob(34, 10, 5, 1.6, R.grass, 0.05);
      p.limb(26, 31, 25, 18, 0.7, R.grass, -0.1); p.limb(27, 31, 29, 21, 0.6, R.grass);
    },
    grave(p) {
      p.blob(8, 7, 6, 5, R.stone, 0.05, undefined, 8);
      p.face(2, 7, 12, 10, R.stone, 0.6, 0.35, 0.3);
      p.face(2, 17, 12, 3, R.stone, 0.22, 0.1, 0);
      p.line(8, 5, 8, 13, R.stone[0]); p.line(5.5, 8, 10.5, 8, R.stone[0]);
      p.line(9, 5, 9, 13, R.stone[4]);
      p.blob(4, 17, 2.5, 1.3, R.grass, 0.1);
    },
    stump(p) {
      p.face(3, 7, 14, 6, R.wood, 0.45, 0.2, 0.15);
      p.blob(10, 7, 7, 2.6, R.dirt, 0.25);
      p.blob(10, 7, 4, 1.4, R.dirt, 0.05);
      p.px(10, 7, R.dirt[1]);
      p.line(6, 9, 6, 12, R.wood[0]); p.line(13, 9, 13, 12, R.wood[0]);
    },
  };
  // w, h, ax, ay — размер и точка опоры (низ)
  const DECOR_DEFS = {
    oak: [48, 62, 24, 59], pine: [32, 56, 16, 54], spruce: [30, 64, 15, 62], deadtree: [40, 56, 20, 54], bush: [28, 20, 14, 18],
    rock_s: [16, 14, 8, 12], rock_m: [26, 22, 13, 20], outcrop: [64, 56, 32, 52], pillar: [20, 48, 10, 46],
    ruinwall: [48, 36, 24, 34], grave: [16, 22, 8, 20], stump: [20, 15, 10, 13],
  };

  // =====================================================================
  // Подбираемые предметы и снаряды
  // =====================================================================
  function buildItems() {
    // кристаллы: 3 ценности × 4 кадра блеска
    const gems = [['gem1', R.ice, 3.5, 4.5], ['gem2', R.toxic, 4.5, 5.5], ['gem3', R.red, 5.5, 6.5]];
    for (const [name, ramp, rw, rh] of gems) {
      const W = Math.ceil(rw * 2 + 4), H = Math.ceil(rh * 2 + 4), cx = W / 2, cy = H / 2;
      define(name, {
        idle: anim(W, H, 4, cx, H - 1, 1, (p, i) => {
          p.poly([cx, cy - rh, cx + rw, cy, cx, cy + rh, cx - rw, cy], ramp, 0, true);
          p.poly([cx, cy - rh, cx, cy + rh, cx - rw, cy], ramp, 0.25, true);
          p.poly([cx, cy - rh, cx + rw, cy, cx, cy - rh * 0.1], ramp, 0.15, true);
          p.line(cx, cy - rh + 1, cx, cy + rh - 1, ramp[ramp.length - 1]);
          if (i === 1) { p.px(cx - 1, cy - rh + 1, WHITE); }
          if (i === 2) { p.px(cx - 1, cy - 2, WHITE); p.px(cx - 2, cy - 2, WHITE); p.px(cx - 1, cy - 3, WHITE); }
        }),
      });
    }

    // магический снаряд
    define('bolt', { idle: anim(11, 11, 2, 5.5, 5.5, 1, (p, i) => {
      p.blob(5.5, 5.5, 3.8 + i * 0.4, 3.8 + i * 0.4, R.purple, 0.25);
      p.blob(4.8, 4.8, 2, 2, R.ice, 0.4);
      p.px(4, 4, WHITE);
    }) });

    // вращающийся клинок
    define('blade', { idle: anim(15, 15, 4, 7.5, 7.5, 1, (p, i) => {
      for (let k = 0; k < 3; k++) {
        const a = i * Math.PI / 6 + k * Math.PI * 2 / 3;
        p.poly([7.5, 7.5, 7.5 + Math.cos(a) * 6.5, 7.5 + Math.sin(a) * 6.5, 7.5 + Math.cos(a + 0.7) * 3.5, 7.5 + Math.sin(a + 0.7) * 3.5], R.steel, 0.15, true);
      }
      p.blob(7.5, 7.5, 1.8, 1.8, R.gold, 0.1);
    }) });

    // след удара мечом: полумесяц вправо от героя, 3 кадра (вспышка → полный → тает)
    define('slash', { idle: anim(48, 48, 3, 8, 24, 1, (p, i) => {
      const cx = 8, cy = 24;
      const a0 = -1.25 + i * 0.25, a1 = 1.0 + i * 0.1;
      for (let k = 0; k <= 24; k++) {
        const t = k / 24, a = a0 + (a1 - a0) * t;
        if (i === 2 && (k & 1)) continue;
        const thick = Math.sin(t * Math.PI) * (i === 1 ? 4.2 : i === 0 ? 2.6 : 2);
        const r = 34 - thick * 0.5;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.82;
        p.blob(x, y, Math.max(0.7, thick * 0.55), Math.max(0.7, thick * 0.55), R.ice, i === 1 ? 0.35 : 0.1);
        if (thick > 2.4) p.px(x + Math.cos(a) * 1.2, y + Math.sin(a) * 1.2, WHITE);
      }
    }) });

    // стрелы в 16 направлениях
    const arrowFrames = (shaft, tip, fletch, len) => anim(15, 15, 16, 7.5, 7.5, 1, (p, i) => {
      const a = i * Math.PI / 8, c = Math.cos(a), s = Math.sin(a);
      const P0 = (u, v) => [7.5 + u * c - v * s, 7.5 + u * s + v * c];
      const t = P0(len / 2, 0), e = P0(-len / 2, 0);
      p.line(e[0], e[1], t[0], t[1], shaft);
      const f1 = P0(-len / 2 + 1, -1.3), f2 = P0(-len / 2 + 1, 1.3);
      p.px(f1[0], f1[1], fletch); p.px(f2[0], f2[1], fletch);
      const h = P0(len / 2 - 0.5, 0);
      p.px(h[0], h[1], tip); p.px(t[0], t[1], tip);
    });
    define('arrow', { idle: arrowFrames(R.wood[3], R.steel[4], R.red[3], 11) });
    define('bonearrow', { idle: arrowFrames(R.bone[2], R.purple[4], R.purple[3], 9) });

    define('fireball', { idle: anim(13, 13, 2, 6.5, 6.5, 1, (p, i) => {
      p.blob(6.5, 6.5, 4.6 - i * 0.4, 4.6 - i * 0.4, R.fire, 0.3);
      p.blob(5.8, 5.6, 2, 2, R.fire, 0.7);
    }) });
    define('acid', { idle: anim(11, 11, 2, 5.5, 5.5, 1, (p, i) => {
      p.blob(5.5, 5.5 + i * 0.3, 3.8, 3.8 - i * 0.4, R.toxic, 0.2);
      p.px(4.2, 4.2, R.toxic[4]);
    }) });

    // сундук
    define('chest', {
      closed: anim(26, 22, 1, 13, 21, 1, (p) => {
        p.face(2, 9, 22, 11, R.wood, 0.45, 0.2, 0.2);
        p.blob(13, 8, 11, 4.5, R.wood, 0.15, undefined, 9);
        for (const x of [5, 19]) { p.rect(x, 4, 2, 16, R.gold[2]); p.px(x, 4, R.gold[4]); }
        p.rect(2, 9, 22, 1.4, R.gold[1]);
        p.rect(11.5, 9, 3, 4, R.gold[3]); p.px(12.5, 11, INK);
      }),
      open: anim(26, 26, 1, 13, 25, 1, (p) => {
        p.face(2, 2, 22, 9, R.wood, 0.3, 0.1, 0.2);
        p.face(2, 13, 22, 11, R.wood, 0.45, 0.2, 0.2);
        p.blob(13, 13, 10, 2.5, R.gold, 0.5);
        for (const x of [5, 19]) p.rect(x, 13, 2, 11, R.gold[2]);
        p.px(9, 11, WHITE); p.px(16, 12, WHITE);
      }),
    });
  }

  // =====================================================================
  // Иконки улучшений 16×16 (карточки, выбор героя, HUD)
  // =====================================================================
  const ICON_ART = {
    bolt(p) {
      p.blob(8, 8, 5.5, 5.5, R.purple, 0.2);
      p.blob(7, 7, 3, 3, R.ice, 0.35);
      p.px(6, 6, WHITE);
      p.px(14, 3, R.purple[4]); p.px(2, 13, R.purple[4]); p.px(13, 13, R.ice[4]);
    },
    orbit(p) {
      for (let k = 0; k < 20; k++) {
        const a = k / 20 * Math.PI * 2;
        if (k % 2) p.px(8 + Math.cos(a) * 6, 8 + Math.sin(a) * 6, R.ice[2]);
      }
      for (const a of [-0.8, 2.34]) {
        const c = Math.cos(a), sn = Math.sin(a), bx = 8 + c * 5, by = 8 + sn * 5;
        p.poly([bx - sn * 4.5, by + c * 4.5, bx + c * 2, by + sn * 2, bx + sn * 4.5, by - c * 4.5, bx - c * 1.2, by - sn * 1.2], R.steel, 0.2, true);
      }
      p.blob(8, 8, 2, 2, R.gold, 0.2);
    },
    nova(p) {
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4, r = k % 2 ? 5.5 : 7.5;
        p.line(8, 8, 8 + Math.cos(a) * r, 8 + Math.sin(a) * r, R.fire[k % 2 ? 2 : 3]);
      }
      p.blob(8, 8, 3.6, 3.6, R.fire, 0.5);
      p.px(7, 7, WHITE);
    },
    arrows(p) {
      for (const o of [-3, 2]) {
        p.line(2 + o, 13, 12 + o, 3, R.wood[3]);
        p.px(12 + o, 3, R.steel[4]); p.px(11 + o, 3, R.steel[3]); p.px(12 + o, 4, R.steel[3]);
        p.px(2 + o, 12, R.red[3]); p.px(3 + o, 14, R.red[3]);
      }
    },
    lightning(p) {
      p.poly([10, 1, 3, 9, 7.5, 9, 5, 15, 13, 6, 8.5, 6, 11, 1], R.ice, 0.35, true);
      p.px(9, 3, WHITE); p.px(7, 8, WHITE);
    },
    speed(p) {
      p.poly([5, 2, 10, 2, 10, 10, 14, 11, 14, 14, 4, 14, 5, 9], R.dirt, 0.15, true);
      p.rect(4, 13, 10, 1.2, R.wood[1]);
      p.line(5, 5, 9, 5, R.dirt[1]);
      p.px(1, 7, R.ice[3]); p.px(1, 10, R.ice[3]); p.px(2, 12, R.ice[2]);
    },
    hp(p) {
      p.blob(5.5, 6.5, 3.6, 3.6, R.red, 0.2);
      p.blob(10.5, 6.5, 3.6, 3.6, R.red, 0.2);
      p.poly([2, 7.5, 14, 7.5, 8, 14.5], R.red, 0, true);
      p.px(4, 5, R.red[4]); p.px(5, 4, WHITE);
    },
    magnet(p) {
      p.limb(4, 4, 4, 10, 2, R.red, 0.1);
      p.limb(12, 4, 12, 10, 2, R.red, 0.1);
      p.blob(8, 10, 5.6, 4.6, R.red, 0.1, 9.5);
      p.blob(8, 10, 2.2, 2, R.red, 0, 9);
      p.rect(2, 2, 4, 3, R.steel[3]); p.rect(10, 2, 4, 3, R.steel[3]);
      for (let x = 6; x < 11; x++) for (let y = 7; y < 12; y++) if (Math.hypot(x + 0.5 - 8, y + 0.5 - 10) < 2.2) p.b.set(x, y, 0);
    },
    might(p) {
      p.limb(13, 3, 6.5, 9.5, 1.5, R.steel, 0.25);
      p.line(12.5, 3.5, 7, 9, R.steel[4]);
      p.limb(4, 7.5, 8.5, 12, 1.1, R.gold, 0.1);
      p.limb(5.8, 10.2, 3.2, 12.8, 1, R.wood, 0.1);
      p.blob(2.6, 13.4, 1.4, 1.4, R.gold, 0.2);
    },
    food(p) {
      p.limb(3, 13, 7, 9, 1.3, R.bone, 0.2);
      p.blob(2.5, 13.5, 1.6, 1.6, R.bone, 0.2);
      p.blob(10, 6.5, 5, 4.5, R.wood, 0.25);
      p.blob(9, 5.5, 2.4, 1.8, R.red, 0.35);
    },
    skull(p) {
      p.blob(8, 7, 5.5, 5, R.bone, 0.15);
      p.rect(5, 10.5, 6, 3.5, R.bone[2]);
      p.rect(4.5, 6, 3, 3, INK); p.rect(8.5, 6, 3, 3, INK);
      p.px(7.5, 10, INK); p.px(8.5, 10, INK);
      p.px(6.5, 13, INK); p.px(9.5, 13, INK);
    },
    sound(p) {
      p.poly([2, 6, 5, 6, 9, 2, 9, 14, 5, 10, 2, 10], R.bone, 0.1, true);
      p.line(11, 5, 11, 11, R.bone[3]); p.line(13, 3, 13, 13, R.bone[2]);
    },
    ring(p) {
      p.blob(8, 10, 5.5, 4.5, R.gold, 0.15);
      p.blob(8, 10.4, 3.2, 2.4, R.gold, -0.2);
      for (let x = 5; x < 12; x++) for (let y = 8; y < 13; y++) if (((x + 0.5 - 8) / 3) ** 2 + ((y + 0.5 - 10.4) / 2.2) ** 2 < 1) p.b.set(x, y, 0);
      p.poly([8, 1.5, 11, 4.5, 8, 7.5, 5, 4.5], R.red, 0.3, true);
      p.px(7, 3, WHITE);
    },
    tome(p) {
      p.face(3, 2, 10, 12, R.blue, 0.55, 0.2, 0.15);
      p.rect(12, 3, 1.5, 11, R.bone[3]);
      p.rect(3, 2, 1.5, 12, R.blue[0]);
      p.rect(6, 5, 5, 1, R.gold[3]); p.rect(6, 7, 4, 1, R.gold[2]);
      p.px(8, 10, R.ice[4]); p.px(7, 11, R.ice[3]); p.px(9, 11, R.ice[3]);
    },
    herb(p) {
      p.line(8, 15, 8, 6, R.grass[2]);
      p.blob(5, 8, 3, 1.7, R.grass, 0.25);
      p.blob(11, 6.5, 3, 1.7, R.grass, 0.25);
      p.blob(7, 3.8, 2.4, 1.6, R.toxic, 0.3);
      p.blob(10, 11.5, 2.4, 1.4, R.grass, 0.2);
      p.px(11, 3, R.red[3]); p.px(4, 4, R.red[4]);
    },
    shell(p) {
      p.blob(8, 8.5, 6, 6, R.stone, 0.15);
      p.line(8, 3, 8, 14, R.stone[1]); p.line(3, 8, 13, 8, R.stone[1]);
      p.px(5, 5, R.toxic[2]); p.px(10, 11, R.toxic[2]); p.px(11, 5, R.fire[2]);
      p.px(6, 4, R.stone[4]);
    },
    coin(p) {
      p.blob(8, 8, 6, 6, R.gold, 0.1);
      p.blob(8, 8, 4, 4, R.gold, -0.15);
      p.rect(7, 5, 2, 6, R.gold[1]);
      p.px(5, 4, WHITE);
    },
    ash(p) {
      p.poly([8, 1, 13.5, 7.5, 8, 15, 2.5, 7.5], R.stone, -0.25, true);
      p.poly([8, 4, 11, 8, 8, 12.5, 5, 8], R.fire, 0.15, true);
      p.poly([8, 5.5, 9.5, 8, 8, 10.5, 6.5, 8], R.fire, 0.55, true);
      p.px(5, 4, R.stone[3]); p.px(4, 5, R.stone[3]);
    },
    scroll(p) {
      p.face(4, 3, 9, 10, R.bone, 0.6, 0.15, 0.2);
      p.limb(3, 3, 13, 3, 1.6, R.dirt, 0.2);
      p.limb(3, 13, 13, 13, 1.6, R.dirt, 0.2);
      p.rect(6, 6, 5, 1, R.bone[0]); p.rect(6, 8, 4, 1, R.bone[0]); p.rect(6, 10, 5, 1, R.bone[0]);
    },
    music(p) {
      p.limb(5, 12, 5, 12, 2.2, R.ice, 0.2);
      p.limb(12, 10.5, 12, 10.5, 2.2, R.ice, 0.2);
      p.rect(6.5, 3, 1.3, 9, R.ice[3]); p.rect(13.5, 2, 1.3, 8.5, R.ice[3]);
      p.poly([6.5, 2.5, 14.8, 1.2, 14.8, 4.2, 6.5, 5.5], R.ice, 0.3, true);
    },
    nomusic(p) {
      ICON_ART.music(p);
      p.line(2, 2, 14, 14, R.red[3]); p.line(2, 3, 13, 14, R.red[2]);
    },
    clover(p) {
      for (const [x, y] of [[5.5, 5.5], [10.5, 5.5], [5.5, 10], [10.5, 10]]) p.blob(x, y, 2.9, 2.9, R.toxic, 0.15);
      p.line(8, 8, 12, 15, R.grass[2]);
      p.px(8, 8, R.toxic[4]); p.px(4, 4, R.toxic[4]);
    },
    gear(p) {
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; p.limb(8, 8, 8 + Math.cos(a) * 6.2, 8 + Math.sin(a) * 6.2, 1.6, R.stone, 0.1); }
      p.blob(8, 8, 4.8, 4.8, R.stone, 0.2);
      p.blob(8, 8, 1.8, 1.8, R.stone, -0.5);
    },
    home(p) {
      p.poly([8, 1.5, 15, 8, 1, 8], R.red, 0.15, true);
      p.face(3, 8, 10, 6.5, R.wood, 0.55, 0.15, 0.2);
      p.rect(7, 10, 2.5, 4.5, R.fire[2]); p.px(7, 10, R.fire[3]);
    },
    helmet(p) {
      p.blob(8, 8, 6, 6, R.steel, 0.15, undefined, 12);
      p.rect(3, 11, 10, 3, R.steel[2]);
      p.rect(6, 7, 1.5, 6, INK); p.rect(9, 7, 1.5, 6, INK); p.rect(5, 8, 6, 1.4, INK);
      p.limb(8, 3, 10, 0.5, 1.2, R.red, 0.2);
    },
    up(p) {
      p.poly([8, 1.5, 14.5, 8, 10.5, 8, 10.5, 14.5, 5.5, 14.5, 5.5, 8, 1.5, 8], R.toxic, 0.2, true);
      p.px(8, 3, R.toxic[4]); p.px(7, 4, R.toxic[4]);
    },
    sword(p) {
      p.limb(4, 12, 12.5, 3.5, 1.3, R.steel, 0.25);
      p.line(5, 11, 12, 4, R.steel[4]);
      p.limb(2.5, 9.5, 6.5, 13.5, 0.9, R.gold, 0.1);
      p.limb(4, 12, 2, 14, 1, R.wood, 0.1);
      p.px(1.5, 14.5, R.gold[3]);
      p.px(13.5, 2.5, WHITE);
    },
    swords(p) {
      p.limb(3, 3, 12, 12, 1.2, R.steel, 0.25);
      p.limb(13, 3, 4, 12, 1.2, R.steel, 0.25);
      p.limb(10, 10, 13.5, 13.5, 1, R.wood, 0.1); p.limb(6, 10, 2.5, 13.5, 1, R.wood, 0.1);
      p.rect(9, 11, 3, 1.4, R.gold[3]); p.rect(4, 11, 3, 1.4, R.gold[3]);
    },
    trophy(p) {
      p.blob(8, 5.5, 5, 4.6, R.gold, 0.15, 2);
      p.rect(3, 2, 10, 1.6, R.gold[3]);
      p.limb(2.5, 4, 2.5, 6, 1, R.gold, 0); p.limb(13.5, 4, 13.5, 6, 1, R.gold, 0);
      p.rect(7, 10, 2, 3, R.gold[2]); p.rect(4.5, 13, 7, 2, R.wood[2]);
      p.px(6, 4, WHITE);
    },
    lock(p) {
      p.limb(5, 7, 5, 4.5, 1.2, R.steel, 0.1); p.limb(11, 7, 11, 4.5, 1.2, R.steel, 0.1);
      p.blob(8, 4.5, 3.4, 3, R.steel, 0.1, undefined, 4.5);
      for (let x = 6; x < 10; x++) for (let y = 2; y < 6; y++) if (Math.hypot(x + 0.5 - 8, y + 0.5 - 4.6) < 2) p.b.set(x, y, 0);
      p.face(3, 7, 10, 8, R.gold, 0.55, 0.15, 0.25);
      p.rect(7.5, 9.5, 1.4, 3, INK);
    },
    check(p) {
      p.line(3, 8, 6, 12, R.toxic[3]); p.line(6, 12, 13, 3, R.toxic[3]);
      p.line(3, 9, 6, 13, R.toxic[2]); p.line(6, 13, 13, 4, R.toxic[2]);
    },
    map_wastes(p) {
      p.face(1, 9, 14, 6, R.grass, 0.6, 0.1, 0.3);
      p.blob(5, 6, 3.5, 3.5, R.grass, 0.25); p.limb(5, 9, 5, 11, 0.8, R.wood, 0);
      p.blob(12, 10.5, 2.4, 1.6, R.stone, 0.2);
      p.px(10, 3, R.bone[3]); p.px(13, 2, R.bone[2]);
    },
    map_barrows(p) {
      p.face(1, 11, 14, 4, R.dirt, 0.5, 0.1, 0.3);
      p.face(3, 5, 10, 3, R.stone, 0.75, 0.1, 0);
      p.face(3, 8, 10, 3.5, R.stone, 0.25, 0.05, 0.15);
      p.rect(7, 2, 2, 3, R.stone[3]);
      p.px(12, 13, R.bone[3]);
    },
    vibe(p) {
      p.face(5, 2, 6, 12, R.steel, 0.4, 0.1, 0.2);
      p.rect(6, 3.5, 4, 8, R.ice[1]);
      for (const x of [2, 14]) { p.line(x, 5, x, 11, R.gold[3]); }
      p.px(3, 7, R.gold[3]); p.px(13, 9, R.gold[3]);
    },
    eye(p) {
      p.blob(8, 8, 7, 4, R.bone, 0.3);
      p.blob(8, 8, 3, 3, R.purple, 0.25);
      p.blob(8, 8, 1.3, 1.3, INK, 0);
      p.px(7, 7, WHITE);
    },
    motion(p) {
      p.blob(11, 8, 3.6, 3.6, R.fire, 0.3);
      p.line(1, 6, 6, 6, R.fire[2]); p.line(2, 8, 7, 8, R.fire[3]); p.line(1, 10, 6, 10, R.fire[2]);
    },
    mute(p) {
      p.poly([2, 6, 5, 6, 9, 2, 9, 14, 5, 10, 2, 10], R.bone, 0.1, true);
      p.line(11, 5, 15, 11, R.red[3]); p.line(15, 5, 11, 11, R.red[3]);
    },
  };
  function buildIcons() {
    for (const name in ICON_ART) define('icon_' + name, { idle: anim(16, 16, 1, 8, 16, 1, (p) => ICON_ART[name](p)) });
  }

  // =====================================================================
  // ТАЙЛЫ ЗЕМЛИ (32×32, в «тоновом» пространстве: индексы тона рампы)
  // Мир берёт тон и сдвигает его для рельефа (обрывы, тени, блики).
  // =====================================================================
  function makeTile(kind, variant) {
    const T = 32, tone = new Uint8Array(T * T), seed = (kind.length * 31 + variant * 7) | 0;
    const rng = makeRng(seed * 977 + 13);
    const ramp = kind === 'grass' ? R.grass : kind === 'dirt' ? R.dirt : R.stone;
    const set = (x, y, t) => { tone[(((y % T) + T) % T) * T + (((x % T) + T) % T)] = t; };
    const get = (x, y) => tone[(((y % T) + T) % T) * T + (((x % T) + T) % T)];
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const n = fbm(x / 8, y / 8, seed, 2, 4);
        const base = kind === 'stone' ? 1.8 : 1.6;
        const t = base + (n - 0.5) * 2.2;
        const b = Math.floor(t);
        tone[y * T + x] = clamp(b + ((t - b) > bayer(x, y) ? 1 : 0), 1, 3);
      }
    }
    if (kind === 'grass') {
      for (let k = 0; k < 46; k++) {
        const x = (rng() * T) | 0, y = (rng() * T) | 0, h = 2 + ((rng() * 2) | 0);
        set(x, y + 1, 0);
        for (let j = 0; j < h; j++) set(x + (j === h - 1 && rng() < 0.5 ? 1 : 0), y - j, j === h - 1 ? 4 : 3);
      }
      for (let k = 0; k < 10; k++) set((rng() * T) | 0, (rng() * T) | 0, 0);
    } else if (kind === 'dirt') {
      for (let k = 0; k < 7; k++) {
        const x = (rng() * T) | 0, y = (rng() * T) | 0;
        set(x, y, 4); set(x + 1, y, 3); set(x, y + 1, 3); set(x + 1, y + 1, 2); set(x + 1, y + 2, 0); set(x + 2, y + 1, 0);
      }
      for (let c = 0; c < 2; c++) {
        let x = (rng() * T) | 0, y = (rng() * T) | 0;
        for (let k = 0; k < 7; k++) { set(x, y, 0); set(x, y + 1, Math.min(4, get(x, y + 1) + 1)); x += rng() < 0.6 ? 1 : 0; y += rng() < 0.5 ? 1 : -1; }
      }
    } else {
      // плиты: блик сверху-слева, тень снизу-справа, швы
      const rows = variant === 2 ? [0, 10, 21] : [0, 16];
      for (let r = 0; r < rows.length; r++) {
        const y0 = rows[r], y1 = r + 1 < rows.length ? rows[r + 1] : T;
        const off = (r * 11 + variant * 5) % 16;
        const step = variant === 1 ? 10 : 16;
        for (let x0 = -off; x0 < T; x0 += step) {
          const x1 = x0 + step;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              if (y === y0 || x === x0) set(x, y, 0);
              else if (y === y0 + 1 || x === x0 + 1) set(x, y, 4);
              else if (y === y1 - 1 || x === x1 - 1) set(x, y, 1);
            }
          }
        }
      }
      let x = (rng() * T) | 0, y = (rng() * T) | 0;
      for (let k = 0; k < 6; k++) { set(x, y, 0); x += rng() < 0.5 ? 1 : 0; y += 1; }
    }
    return { kind, ramp, tone };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Мелкие детали земли — «запекаются» в чанки
  function buildDecals() {
    const out = { grass: [], dirt: [], stone: [] };
    const mk = (w, h, fn) => { const b = new PixelBuffer(w, h); fn(new Painter(b, 1, 0, 0)); return b; };
    const flower = (petal) => mk(5, 5, (p) => { p.px(2, 1, petal[3]); p.px(1, 2, petal[2]); p.px(3, 2, petal[2]); p.px(2, 3, petal[1]); p.px(2, 2, R.gold[4]); p.px(2, 4, R.grass[0]); });
    out.grass.push(flower(R.red), flower(R.purple), flower(R.ice), flower(R.gold));
    out.grass.push(mk(7, 6, (p) => { p.line(1, 5, 0, 2, R.grass[3]); p.line(3, 5, 3, 0, R.grass[4]); p.line(5, 5, 6, 2, R.grass[3]); p.line(1, 5, 5, 5, R.grass[0]); }));
    out.grass.push(mk(6, 6, (p) => { p.blob(3, 2.5, 2.4, 1.6, R.red, 0.1); p.px(2, 2, R.bone[3]); p.rect(2.5, 3.5, 1, 2, R.bone[2]); }));
    const pebble = mk(5, 4, (p) => { p.blob(2.5, 1.8, 2, 1.4, R.stone, 0); p.px(3, 3, R.stone[0]); });
    const bones = mk(8, 5, (p) => { p.limb(1.5, 3, 6.5, 1.5, 0.8, R.bone, 0); p.px(1, 2, R.bone[3]); p.px(7, 1, R.bone[3]); });
    const skull = mk(6, 6, (p) => { p.blob(3, 2.6, 2.4, 2.2, R.bone, 0.05); p.px(2, 2.5, INK); p.px(3.8, 2.5, INK); p.px(3, 4.4, R.bone[1]); });
    out.dirt.push(pebble, bones, skull, mk(6, 4, (p) => { p.blob(2, 2, 1.6, 1.2, R.stone, 0); p.blob(4.3, 2.4, 1.2, 1, R.stone, -0.1); }));
    out.stone.push(pebble, skull, mk(6, 4, (p) => { p.blob(3, 2, 2.6, 1.3, R.grass, 0.05); }));
    return out;
  }

  // =====================================================================
  // Свечения (additive) и тени — обычные канвасы
  // =====================================================================
  function makeGlow(hex, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, hex);
    grd.addColorStop(0.35, hex + '88');
    grd.addColorStop(1, hex + '00');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  }
  /** Мягкая овальная тень с дизерингом по краю. */
  function makeShadow(w) {
    const h = Math.max(3, Math.round(w * 0.42));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h), d = new Uint32Array(img.data.buffer);
    const ink = P.rgba[INK] & 0x00ffffff;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x + 0.5 - w / 2) / (w / 2), ny = (y + 0.5 - h / 2) / (h / 2), r = nx * nx + ny * ny;
        if (r > 1) continue;
        if (r > 0.55 && (r - 0.55) / 0.45 > bayer(x, y)) continue;
        d[y * w + x] = (ink | (115 << 24)) >>> 0;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // =====================================================================
  // Публичный API
  // =====================================================================
  const Sprites = {
    ready: false,
    atlas: null,
    tiles: null,
    decals: null,
    glow: {},
    shadows: [],
    decor: DECOR_DEFS,
    makeRng, hash2, fbm, valueNoise, bayer,

    init() {
      if (this.ready) return;
      for (const h of ['knight', 'witch', 'huntress', 'gravedigger']) buildHero(h);
      buildMob('ghoul', 32, 32, 15, 30);
      buildMob('bat', 32, 26, 16, 24);
      buildMob('hound', 32, 32, 16, 30, 'attack');
      buildMob('archer', 32, 32, 15, 30, 'attack');
      buildMob('slime', 32, 32, 16, 30);
      buildMob('golem', 32, 48, 16, 46);
      buildMob('ghost', 32, 30, 16, 27);
      buildMob('imp', 32, 32, 15, 30, 'attack');
      define('slimelet', { walk: anim(32, 32, 4, 16, 30, 0.55, (p, i) => MOB_ART.slime(p, i)) });
      buildBoss('reaper', 80, 78, 40, 74);
      buildBoss('queen', 96, 80, 50, 74);
      buildBoss('ashgar', 96, 96, 48, 92);
      for (const name in DECOR_DEFS) {
        const [w, h, ax, ay] = DECOR_DEFS[name];
        define('decor_' + name, { idle: anim(w, h, 1, ax, ay, 1, (p) => DECOR_ART[name](p)) });
      }
      buildItems();
      buildIcons();

      this.tiles = {
        grass: [0, 1, 2].map((v) => makeTile('grass', v)),
        dirt: [0, 1, 2].map((v) => makeTile('dirt', v)),
        stone: [0, 1, 2].map((v) => makeTile('stone', v)),
      };
      this.decals = buildDecals();

      const glowColors = { gold: '#f4c95a', ice: '#78d0e0', purple: '#9a58c4', red: '#dc4a3a', toxic: '#7fd450', fire: '#ec6a14', white: '#ffffff', warm: '#ffae3a' };
      for (const k in glowColors) this.glow[k] = makeGlow(glowColors[k], 64);
      for (const w of [8, 12, 16, 20, 26, 34, 46, 64, 90]) this.shadows.push(makeShadow(w));

      this.atlas = buildAtlas();
      this.ready = true;
    },

    get(name) { return sprites[name]; },
    names() { return Object.keys(sprites); },

    /** Рисует кадр так, что его точка опоры (ноги) попадает в (x, y). */
    draw(ctx, f, x, y, flip, flash) {
      const sx = flash ? f.fx : f.x, sy = flash ? f.fy : f.y;
      const dy = Math.round(y - f.ay);
      if (!flip) {
        ctx.drawImage(this.atlas, sx, sy, f.w, f.h, Math.round(x - f.ax), dy, f.w, f.h);
      } else {
        ctx.setTransform(-1, 0, 0, 1, Math.round(x + f.ax), dy);
        ctx.drawImage(this.atlas, sx, sy, f.w, f.h, 0, 0, f.w, f.h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    },

    /** Тень подходящей ширины. */
    shadow(w) {
      const list = this.shadows;
      for (let i = 0; i < list.length; i++) if (list[i].width >= w) return list[i];
      return list[list.length - 1];
    },

    /** Для отладки и галереи: индексные буферы всех кадров. */
    _entries: entries,
  };

  window.Sprites = Sprites;
})();
