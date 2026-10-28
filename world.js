'use strict';
/*
 * Бесконечный мир: земля чанками 256×256 (заранее отрендеренные offscreen-канвасы),
 * декорации и препятствия, расставленные детерминированно через seed.
 *
 * Поверхности: трава, земля (одна высота, плавный переход с дизерингом)
 * и каменные плато (выше: светлая кромка, тёмный обрыв, падающая тень).
 */
(function () {
  const CHUNK = 256;
  const MARGIN = 8;             // поля вокруг чанка для соседних пикселей
  const WALL = 7;               // высота обрыва плато в пикселях
  const WALL_TONES = [2, 2, 1, 1, 1, 0, 0];
  const OB_CELL = 64;           // сетка препятствий
  const OB_PAD = 20;            // запас на радиус самых крупных существ
  const GRASS = 0, DIRT = 1, STONE = 2;
  const MAT_NAMES = ['grass', 'dirt', 'stone'];

  // Препятствия декораций: [dx, dy, r] относительно точки опоры; тени — ширина
  const DECOR_INFO = {
    oak:      { col: [[0, -2, 5]], shadow: 38, fade: true },
    pine:     { col: [[0, -1, 4]], shadow: 22, fade: true },
    spruce:   { col: [[0, -1, 4]], shadow: 26, fade: true },
    deadtree: { col: [[0, -1, 4]], shadow: 20, fade: true },
    bush:     { col: [], shadow: 26 },
    rock_s:   { col: [[0, -3, 5]], shadow: 14 },
    rock_m:   { col: [[0, -5, 9]], shadow: 24 },
    outcrop:  { col: [[-14, -13, 13], [13, -13, 13], [0, -16, 15]], shadow: 64, fade: true },
    pillar:   { col: [[0, -3, 7]], shadow: 20, fade: true },
    ruinwall: { col: [[-15, -6, 7], [-5, -6, 7], [5, -6, 7], [15, -6, 7]], shadow: 46, fade: true },
    grave:    { col: [[0, -3, 5]], shadow: 16 },
    stump:    { col: [[0, -4, 6]], shadow: 18 },
  };
  // что растёт на какой поверхности: [вероятность клетки, [[тип, вес]…]]
  const SPAWN_TABLE = [
    // трава: хвойный лес — сосны и ели, дубы редко
    [0.5, [['pine', 30], ['spruce', 28], ['bush', 18], ['oak', 4], ['deadtree', 8], ['stump', 7], ['rock_s', 5]]],
    [0.3, [['rock_s', 30], ['rock_m', 20], ['deadtree', 20], ['grave', 15], ['stump', 15]]],
    [0.45, [['outcrop', 30], ['pillar', 22], ['ruinwall', 14], ['rock_m', 24], ['grave', 10]]],
  ];

  function pick(list, r) {
    let total = 0;
    for (const it of list) total += it[1];
    let v = r * total;
    for (const it of list) { v -= it[1]; if (v <= 0) return it[0]; }
    return list[0][0];
  }
  function cellKey(cx, cy) { return ((cx + 0x8000) & 0xffff) * 0x10000 + ((cy + 0x8000) & 0xffff); }

  class World {
    /** opts.dirt / opts.stone — пороги шума: больше земли или каменных плато (разные карты). */
    constructor(seed, opts) {
      this.seed = seed | 0;
      this.dirtT = opts && opts.dirt !== undefined ? opts.dirt : 0.4;
      this.stoneT = opts && opts.stone !== undefined ? opts.stone : 0.64;
      this.decorMul = opts && opts.decor !== undefined ? opts.decor : 1;
      this.chunks = new Map();
      this.cells = new Map();     // ключ клетки → массив препятствий
      this.visibleDecor = [];
      this.tick = 0;
    }

    // ---------- Поле поверхностей ----------
    fields(wx, wy) {
      const S = Sprites;
      return [S.fbm(wx / 150, wy / 150, this.seed, 3), S.fbm(wx / 230, wy / 230, this.seed + 500, 3)];
    }
    /** Тип поверхности в точке мира (без дизеринга) — для расстановки. */
    materialAt(wx, wy) {
      const f = this.fields(wx, wy);
      if (f[1] > this.stoneT) return STONE;
      return f[0] < this.dirtT ? DIRT : GRASS;
    }

    // ---------- Чанки ----------
    chunkKey(cx, cy) { return cellKey(cx, cy); }

    /** Генерирует видимые чанки сразу, соседние — по одному за кадр. */
    update(L, T, R, B) {
      this.tick++;
      const c0 = Math.floor(L / CHUNK), c1 = Math.floor(R / CHUNK);
      const r0 = Math.floor(T / CHUNK), r1 = Math.floor(B / CHUNK);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const ch = this.chunks.get(this.chunkKey(cx, cy));
          if (ch) ch.used = this.tick; else this.load(cx, cy);
        }
      }
      // предзагрузка кольца вокруг экрана — не больше одного чанка за кадр
      outer:
      for (let cy = r0 - 1; cy <= r1 + 1; cy++) {
        for (let cx = c0 - 1; cx <= c1 + 1; cx++) {
          const ch = this.chunks.get(this.chunkKey(cx, cy));
          if (ch) { ch.used = this.tick; continue; }
          this.load(cx, cy);
          break outer;
        }
      }
      // выгрузка давно не нужных
      if (this.chunks.size > 36) {
        for (const [k, ch] of this.chunks) {
          if (this.tick - ch.used > 120) this.unload(k, ch);
        }
      }
    }

    load(cx, cy) {
      const ch = { cx, cy, used: this.tick, canvas: null, decor: [], obstacles: [] };
      const mat = this.buildMaterials(cx, cy);
      ch.canvas = this.renderGround(cx, cy, mat);
      this.placeDecor(ch, mat);
      for (const o of ch.obstacles) this.addObstacle(o);
      this.chunks.set(this.chunkKey(cx, cy), ch);
      return ch;
    }

    unload(key, ch) {
      for (const o of ch.obstacles) this.removeObstacle(o);
      this.chunks.delete(key);
    }

    /** Карта поверхностей чанка с полями. Шум считается на сетке 4 px и интерполируется. */
    buildMaterials(cx, cy) {
      const S = Sprites, N = CHUNK + MARGIN * 2, step = 4, G = N / step + 2;
      const ox = cx * CHUNK - MARGIN, oy = cy * CHUNK - MARGIN;
      const a = new Float32Array(G * G), b = new Float32Array(G * G);
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const f = this.fields(ox + i * step, oy + j * step);
          a[j * G + i] = f[0]; b[j * G + i] = f[1];
        }
      }
      const m = new Uint8Array(N * N);
      for (let y = 0; y < N; y++) {
        const gy = y / step, j = gy | 0, fy = gy - j;
        for (let x = 0; x < N; x++) {
          const gx = x / step, i = gx | 0, fx = gx - i, k = j * G + i;
          const v1 = (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + G] * (1 - fx) + a[k + G + 1] * fx) * fy;
          const v2 = (b[k] * (1 - fx) + b[k + 1] * fx) * (1 - fy) + (b[k + G] * (1 - fx) + b[k + G + 1] * fx) * fy;
          const wx = ox + x, wy = oy + y;
          if (v2 > this.stoneT) m[y * N + x] = STONE;
          else m[y * N + x] = v1 + (S.bayer(wx, wy) - 0.5) * 0.07 < this.dirtT ? DIRT : GRASS;
        }
      }
      return m;
    }

    renderGround(cx, cy, m) {
      const S = Sprites, Pal = window.Palette, rgba = Pal.rgba, stone = Pal.ramps.stone;
      const N = CHUNK + MARGIN * 2;
      const canvas = document.createElement('canvas');
      canvas.width = CHUNK; canvas.height = CHUNK;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(CHUNK, CHUNK);
      const out = new Uint32Array(img.data.buffer);
      const tiles = S.tiles;
      for (let y = 0; y < CHUNK; y++) {
        const wy = cy * CHUNK + y;
        for (let x = 0; x < CHUNK; x++) {
          const wx = cx * CHUNK + x;
          const i = (y + MARGIN) * N + (x + MARGIN);
          const mt = m[i];
          let color;
          // обрыв: над пикселем (в пределах WALL) есть плато
          let wall = 0;
          if (mt !== STONE) {
            for (let k = 1; k <= WALL; k++) if (m[i - k * N] === STONE) { wall = k; break; }
          }
          if (wall) {
            let t = WALL_TONES[wall - 1];
            const streak = S.hash2(wx, wy >> 3, 7);
            if (streak < 0.25) t = Math.max(0, t - 1);
            else if (streak > 0.9 && wall < WALL) t = Math.min(3, t + 1);
            color = rgba[stone[t]];
          } else {
            const variant = (S.hash2(wx >> 5, wy >> 5, this.seed) * 3) | 0;
            const tex = tiles[MAT_NAMES[mt]][variant];
            let t = tex.tone[(y & 31) * 32 + (x & 31)];
            if (mt === STONE) {
              if (m[i + N] !== STONE) t = 4;                          // светлая кромка над обрывом
              else if (m[i - 1] !== STONE) t = Math.min(4, t + 1);    // левый край освещён
              else if (m[i + 1] !== STONE) t = Math.max(0, t - 1);    // правый — в тени
            } else {
              // тень от плато падает вниз-вправо
              const sh = m[i - (WALL + 1) * N] === STONE || m[i - (WALL + 2) * N - 2] === STONE;
              if (sh && S.bayer(wx, wy) < 0.75) t = Math.max(0, t - 1);
              // трава нависает над землёй
              if (mt === DIRT && m[i - N] === GRASS) t = Math.max(0, t - 1);
              else if (mt === GRASS && m[i + N] === DIRT) t = Math.max(t, 3);
            }
            color = rgba[tex.ramp[t]];
          }
          out[y * CHUNK + x] = color;
        }
      }
      // мелкие детали: цветы, камешки, кости
      const rng = S.makeRng(this.seed ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663));
      for (let k = 0; k < 34; k++) {
        const x = (rng() * (CHUNK - 8)) | 0, y = (rng() * (CHUNK - 8)) | 0;
        const mt = m[(y + MARGIN + 3) * N + (x + MARGIN + 3)];
        if (m[(y + MARGIN + 3 - WALL) * N + (x + MARGIN + 3)] !== mt) continue;
        const list = S.decals[MAT_NAMES[mt]];
        const d = list[(rng() * list.length) | 0];
        for (let j = 0; j < d.h; j++) for (let i2 = 0; i2 < d.w; i2++) {
          const v = d.px[j * d.w + i2];
          if (v) out[(y + j) * CHUNK + x + i2] = rgba[v];
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    }

    // ---------- Декорации ----------
    placeDecor(ch, m) {
      const S = Sprites, N = CHUNK + MARGIN * 2;
      const rng = S.makeRng((this.seed * 31) ^ Math.imul(ch.cx, 2654435761) ^ Math.imul(ch.cy, 40503));
      const baseX = ch.cx * CHUNK, baseY = ch.cy * CHUNK;
      const add = (type, x, y) => {
        if (x * x + y * y < 150 * 150) return;          // стартовая поляна
        const info = DECOR_INFO[type], spr = S.get('decor_' + type);
        // dk: 0 — DK_DECOR в game.js (сортировка отрисовки по Y)
        const d = { dk: 0, type, x, y, frame: spr.anims.idle[0], shadow: S.shadow(info.shadow), fade: !!info.fade, flip: rng() < 0.5 && type !== 'outcrop' };
        ch.decor.push(d);
        for (const c of info.col) ch.obstacles.push({ x: x + (d.flip ? -c[0] : c[0]), y: y + c[1], r: c[2] });
      };
      // руины: редкое скопление колонн, стен и могил
      if (rng() < 0.12) {
        const cx = baseX + 128, cy = baseY + 128;
        for (let k = 0; k < 6; k++) {
          const a = k / 6 * Math.PI * 2 + rng() * 0.3;
          add(k % 3 === 0 ? 'ruinwall' : 'pillar', cx + Math.cos(a) * 70, cy + Math.sin(a) * 55);
        }
        for (let k = 0; k < 4; k++) add('grave', cx - 30 + rng() * 60, cy - 20 + rng() * 40);
        return;
      }
      const cell = 64;
      for (let gy = 0; gy < CHUNK / cell; gy++) {
        for (let gx = 0; gx < CHUNK / cell; gx++) {
          const lx = gx * cell + 12 + rng() * (cell - 24), ly = gy * cell + 16 + rng() * (cell - 24);
          const mt = m[((ly | 0) + MARGIN) * N + ((lx | 0) + MARGIN)];
          const tbl = SPAWN_TABLE[mt];
          const roll = rng(), kind = rng();
          if (roll > tbl[0] * this.decorMul) continue;
          let type = pick(tbl[1], kind);
          // выступы — только на плато, остальное — не на самом краю обрыва
          if (type === 'outcrop' && mt !== STONE) continue;
          const below = m[((ly | 0) + MARGIN + 4) * N + ((lx | 0) + MARGIN)];
          if (below !== mt) continue;
          add(type, baseX + lx, baseY + ly);
        }
      }
    }

    /** Видимые декорации (без аллокаций в типичном кадре). */
    collectDecor(L, T, R, B) {
      const out = this.visibleDecor;
      out.length = 0;
      const c0 = Math.floor((L - 64) / CHUNK), c1 = Math.floor((R + 64) / CHUNK);
      const r0 = Math.floor((T - 16) / CHUNK), r1 = Math.floor((B + 80) / CHUNK);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const ch = this.chunks.get(this.chunkKey(cx, cy));
          if (!ch) continue;
          const list = ch.decor;
          for (let i = 0; i < list.length; i++) {
            const d = list[i], f = d.frame;
            if (d.x + f.w < L || d.x - f.w > R || d.y < T - 4 || d.y - f.h > B) continue;
            out.push(d);
          }
        }
      }
      return out;
    }

    drawGround(ctx, L, T, R, B) {
      const c0 = Math.floor(L / CHUNK), c1 = Math.floor(R / CHUNK);
      const r0 = Math.floor(T / CHUNK), r1 = Math.floor(B / CHUNK);
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const ch = this.chunks.get(this.chunkKey(cx, cy));
          if (ch) ctx.drawImage(ch.canvas, cx * CHUNK - L, cy * CHUNK - T);
        }
      }
    }

    // ---------- Препятствия ----------
    addObstacle(o) {
      const x0 = Math.floor((o.x - o.r - OB_PAD) / OB_CELL), x1 = Math.floor((o.x + o.r + OB_PAD) / OB_CELL);
      const y0 = Math.floor((o.y - o.r - OB_PAD) / OB_CELL), y1 = Math.floor((o.y + o.r + OB_PAD) / OB_CELL);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = cellKey(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(o);
      }
    }
    removeObstacle(o) {
      const x0 = Math.floor((o.x - o.r - OB_PAD) / OB_CELL), x1 = Math.floor((o.x + o.r + OB_PAD) / OB_CELL);
      const y0 = Math.floor((o.y - o.r - OB_PAD) / OB_CELL), y1 = Math.floor((o.y + o.r + OB_PAD) / OB_CELL);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = cellKey(cx, cy), arr = this.cells.get(k);
        if (!arr) continue;
        const i = arr.indexOf(o);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) this.cells.delete(k);
      }
    }
    /** Выталкивает круг (obj.x, obj.y, r) из препятствий. Возвращает true при касании. */
    resolve(obj, r) {
      const arr = this.cells.get(cellKey(Math.floor(obj.x / OB_CELL), Math.floor(obj.y / OB_CELL)));
      if (!arr) return false;
      let hit = false;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i], dx = obj.x - o.x, dy = obj.y - o.y, rr = o.r + r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01, push = rr - d;
        obj.x += dx / d * push; obj.y += dy / d * push;
        hit = true;
      }
      return hit;
    }
    /** Свободна ли точка (для появления врагов и сундуков). */
    isFree(x, y, r) {
      const arr = this.cells.get(cellKey(Math.floor(x / OB_CELL), Math.floor(y / OB_CELL)));
      if (!arr) return true;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i], dx = x - o.x, dy = y - o.y, rr = o.r + r;
        if (dx * dx + dy * dy < rr * rr) return false;
      }
      return true;
    }
  }

  World.CHUNK = CHUNK;
  window.World = World;
})();
