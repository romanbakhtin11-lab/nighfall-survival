'use strict';
/*
 * «Ночной рой» — bullet heaven в стиле 32-битного пиксель-арта.
 *
 * Файлы:
 *   palette.js   — единая палитра
 *   sprites.js   — процедурные спрайты, тайлы, атлас (заменяемо на PNG)
 *   world.js     — чанки земли, декорации, препятствия
 *   heroes.js / enemies.js / bosses.js — данные персонажей
 *   behaviors.js — модули поведения мобов и способностей боссов
 *   game.js      — этот файл: цикл, сущности, оружие, интерфейс, рендер
 *
 * Мир рисуется в буфер низкого разрешения (1 пиксель арта = 1 единица мира),
 * который растягивается на экран целым множителем без сглаживания.
 * В игровом цикле нет аллокаций: все сущности живут в пулах.
 */
(function () {

  // =====================================================================
  // Константы
  // =====================================================================
  const TAU = Math.PI * 2;
  const ART_SHORT = 300;          // сколько пикселей арта по короткой стороне экрана
  const MAX_DPR = 3;
  const MAX_ENEMIES = 450;
  const MAX_PROJ = 220;
  const MAX_SHOTS = 300;
  const MAX_GEMS = 600;
  const MAX_PARTICLES = 500;
  const MAX_RINGS = 24;
  const MAX_ZONES = 24;
  const MAX_BOLTS = 64;
  const MAX_NUMS = 70;
  const MAX_ENEMY_R = 18;
  const GRID_CELL = 48;
  const BEST_KEY = 'night-swarm-best';
  const GLOW_HEX = {
    gold: '#f4c95a', ice: '#78d0e0', purple: '#9a58c4', red: '#dc4a3a',
    toxic: '#7fd450', fire: '#ec6a14', white: '#ffffff', warm: '#ffae3a',
  };
  const AMBIENT = '#9d97c4';      // ночное освещение (multiply)
  const FONT = '"Press Start 2P", ui-monospace, monospace';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function formatTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function loadNum(key) { try { return parseFloat(localStorage.getItem(key)) || 0; } catch (e) { return 0; } }
  function loadStr(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function save(key, v) { try { localStorage.setItem(key, String(v)); } catch (e) { /* приватный режим */ } }

  // =====================================================================
  // Pool и SpatialGrid
  // =====================================================================
  class Pool {
    constructor(Factory, size) {
      this.items = new Array(size);
      for (let i = 0; i < size; i++) this.items[i] = new Factory();
      this.count = 0;
    }
    get full() { return this.count >= this.items.length; }
    obtain() {
      if (this.count >= this.items.length) return null;
      const o = this.items[this.count++];
      o.alive = true;
      return o;
    }
    sweep() {
      const it = this.items;
      let i = 0;
      while (i < this.count) {
        if (!it[i].alive) { const last = --this.count; const t = it[i]; it[i] = it[last]; it[last] = t; } else i++;
      }
    }
    clear() { for (let i = 0; i < this.count; i++) this.items[i].alive = false; this.count = 0; }
  }

  class SpatialGrid {
    constructor(cellSize, maxItems) {
      this.inv = 1 / cellSize;
      this.mask = 2047;
      this.head = new Int32Array(this.mask + 1);
      this.next = new Int32Array(maxItems);
      this.stamp = new Int32Array(maxItems);
      this.result = new Int32Array(maxItems);
      this.queryId = 0;
    }
    hash(cx, cy) { return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & this.mask; }
    build(pool) {
      this.head.fill(-1);
      const it = pool.items, inv = this.inv;
      for (let i = 0; i < pool.count; i++) {
        const b = this.hash(Math.floor(it[i].x * inv), Math.floor(it[i].y * inv));
        this.next[i] = this.head[b]; this.head[b] = i;
      }
    }
    query(x, y, r) {
      const inv = this.inv;
      const x0 = Math.floor((x - r) * inv), x1 = Math.floor((x + r) * inv);
      const y0 = Math.floor((y - r) * inv), y1 = Math.floor((y + r) * inv);
      const qid = ++this.queryId;
      let n = 0;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          let i = this.head[this.hash(cx, cy)];
          while (i !== -1) {
            if (this.stamp[i] !== qid) { this.stamp[i] = qid; this.result[n++] = i; }
            i = this.next[i];
          }
        }
      }
      return n;
    }
  }

  // =====================================================================
  // Input — плавающий джойстик + WASD/стрелки
  // =====================================================================
  class Input {
    constructor(el) {
      this.radius = 56;
      this.pid = -1; this.active = false;
      this.ox = 0; this.oy = 0; this.px = 0; this.py = 0;
      this.dx = 0; this.dy = 0;
      this.keys = Object.create(null);
      el.addEventListener('pointerdown', (e) => {
        if (this.pid !== -1) return;
        e.preventDefault();
        this.pid = e.pointerId; this.active = true;
        this.ox = this.px = e.clientX; this.oy = this.py = e.clientY;
        if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      });
      window.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.pid) return;
        this.px = e.clientX; this.py = e.clientY;
        const vx = this.px - this.ox, vy = this.py - this.oy, d = Math.hypot(vx, vy);
        if (d > this.radius) { this.ox = this.px - vx / d * this.radius; this.oy = this.py - vy / d * this.radius; }
      });
      const end = (e) => { if (e.pointerId === this.pid) { this.pid = -1; this.active = false; } };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      window.addEventListener('blur', () => this.reset());
    }
    update() {
      let x = 0, y = 0;
      if (this.active) {
        const vx = this.px - this.ox, vy = this.py - this.oy, d = Math.hypot(vx, vy);
        if (d > 6) { const m = clamp((d - 6) / (this.radius * 0.6), 0, 1); x = vx / d * m; y = vy / d * m; }
      } else {
        const k = this.keys;
        if (k.KeyW || k.ArrowUp) y -= 1;
        if (k.KeyS || k.ArrowDown) y += 1;
        if (k.KeyA || k.ArrowLeft) x -= 1;
        if (k.KeyD || k.ArrowRight) x += 1;
        if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
      }
      this.dx = x; this.dy = y;
    }
    reset() {
      this.pid = -1; this.active = false; this.dx = 0; this.dy = 0;
      for (const k in this.keys) this.keys[k] = false;
    }
  }

  // =====================================================================
  // Сущности (живут в пулах). dk — тип для сортировки отрисовки по Y.
  // =====================================================================
  const DK_DECOR = 0, DK_ENEMY = 1, DK_PLAYER = 2, DK_BOSS = 3, DK_CHEST = 4;

  class Enemy {
    constructor() {
      this.alive = false; this.dk = DK_ENEMY; this.uid = 0;
      this.def = null; this.beh = null; this.spr = null;
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.kx = 0; this.ky = 0;
      this.dirX = 1; this.dirY = 0; this.r = 6; this.scale = 1;
      this.hp = 1; this.maxHp = 1; this.speed = 0; this.dmg = 0; this.dmgMul = 1; this.xp = 1;
      this.elite = false; this.flash = 0; this.orbitHit = -10; this.animT = 0; this.chain = 0;
      this.state = 0; this.timer = 0; this.cd = 0; this.ax = 0; this.ay = 0; this.tele = false; this.seed = 0;
    }
  }
  class Projectile {
    constructor() {
      this.alive = false; this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
      this.r = 4; this.dmg = 0; this.pierce = 1; this.life = 0; this.kind = 0;
      this.hits = new Int32Array(12); this.hitCount = 0;
    }
    hasHit(uid) { for (let i = 0; i < this.hitCount; i++) if (this.hits[i] === uid) return true; return false; }
    addHit(uid) { if (this.hitCount < this.hits.length) this.hits[this.hitCount++] = uid; }
  }
  class Shot {
    constructor() { this.alive = false; this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.dmg = 0; this.life = 0; this.spr = null; this.glow = 'red'; this.r = 3; }
  }
  class Gem { constructor() { this.alive = false; this.x = 0; this.y = 0; this.value = 1; this.attract = false; this.spd = 0; this.seed = 0; } }
  class Particle {
    constructor() { this.alive = false; this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0; this.life = 0; this.maxLife = 1; this.size = 1; this.color = '#fff'; }
  }
  class Ring { constructor() { this.alive = false; this.x = 0; this.y = 0; this.r = 10; this.t = 0; this.dur = 0.35; this.hex = '#fff'; } }
  class Zone { constructor() { this.alive = false; this.x = 0; this.y = 0; this.r = 20; this.warn = 1; this.dur = 3; this.t = 0; this.dps = 10; this.hex = '#fff'; } }
  class Bolt { constructor() { this.alive = false; this.x0 = 0; this.y0 = 0; this.x1 = 0; this.y1 = 0; this.life = 0; } }
  class DmgNum { constructor() { this.alive = false; this.x = 0; this.y = 0; this.value = 0; this.life = 0; this.color = 0; } }

  // Пиксельные цифры 3×5 для всплывающего урона: заранее отрисованы в канвасы по цветам
  const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
    '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];
  const NUM_WHITE = 0, NUM_GOLD = 1, NUM_RED = 2;
  function buildDigits() {
    const colors = ['#ffffff', '#f4c95a', '#f5856a'], out = [];
    for (const col of colors) {
      const row = [];
      for (const bits of DIGITS) {
        const c = document.createElement('canvas'); c.width = 5; c.height = 7;
        const g = c.getContext('2d');
        g.fillStyle = '#0d0a14';
        for (let i = 0; i < 15; i++) if (bits[i] === '1') g.fillRect(i % 3, (i / 3) | 0, 3, 3);
        g.fillStyle = col;
        for (let i = 0; i < 15; i++) if (bits[i] === '1') g.fillRect(1 + i % 3, 1 + ((i / 3) | 0), 1, 1);
        row.push(c);
      }
      out.push(row);
    }
    return out;
  }

  // =====================================================================
  // Player
  // =====================================================================
  const XP_RATE = 0.85;   // общий множитель получаемого опыта
  function xpForLevel(l) { return Math.floor(5 + l * 2.5 + Math.pow(l, 1.5) * 0.6); }

  class Player {
    constructor() { this.dk = DK_PLAYER; this.hero = null; }
    reset(hero) {
      const s = hero.stats;
      this.hero = hero; this.spr = Sprites.get(hero.sprite);
      this.x = 0; this.y = 0; this.r = 6;
      this.maxHp = s.hp; this.hp = s.hp;
      this.baseSpeed = s.speed; this.speedMul = 1;
      this.baseMagnet = s.magnet; this.magnetMul = 1;
      this.damageMul = s.might; this.armor = s.armor; this.regen = s.regen;
      this.level = 1; this.xp = 0; this.xpNext = xpForLevel(1);
      this.dirX = 1; this.dirY = 0; this.facing = 1; this.moving = false;
      this.animT = 0; this.hurtT = 0; this.iframes = 0; this.deathT = 0;
      this.extVX = 0; this.extVY = 0; this.knockX = 0; this.knockY = 0;
      this.passives = { speed: 0, hp: 0, magnet: 0, might: 0 };
      this.xpMul = 1; this.luck = 0;
      this.aimFacing = 1; this.aimT = 0;
      this.atkT = 0; this.atkDur = 0;
    }
    /** Запустить анимацию удара (если у героя она есть). */
    swing(dur) { if (this.spr.anims.attack) { this.atkT = dur; this.atkDur = dur; } }
    /** Выстрел в сторону dx: герой поворачивается к цели и держит поворот до следующего выстрела. */
    aimAt(dx) { if (dx > 1 || dx < -1) { this.aimFacing = dx > 0 ? 1 : -1; this.aimT = 0.8; } }
    /** Постоянные бонусы из меню прокачки (Meta.bonuses). */
    applyMeta(b) {
      this.maxHp = Math.round(this.maxHp * b.hpMul + b.hp); this.hp = this.maxHp;
      this.damageMul += b.might; this.speedMul += b.speed; this.magnetMul += b.magnet;
      this.regen += b.regen; this.armor += b.armor; this.xpMul = 1 + b.xp; this.luck = b.luck;
    }
    get speed() { return this.baseSpeed * this.speedMul; }
    get magnet() { return this.baseMagnet * this.magnetMul; }
    frame() {
      const a = this.spr.anims;
      if (this.deathT > 0) return a.death[Math.min(a.death.length - 1, (this.deathT * 6) | 0)];
      if (this.hurtT > 0) return a.hurt[0];
      if (this.atkT > 0) {
        const n = a.attack.length, ph = Math.min(n - 1, ((1 - this.atkT / this.atkDur) * n) | 0);
        return this.moving ? a.attackWalk[ph * 4 + (((this.animT * 9) | 0) % 4)] : a.attack[ph];
      }
      if (this.moving) return a.walk[((this.animT * 9) | 0) % a.walk.length];
      return a.idle[((this.animT * 2) | 0) % a.idle.length];
    }
  }

  // =====================================================================
  // Оружие. Характеристики — формулы от уровня (описание следующего
  // уровня генерируется из них же).
  // =====================================================================
  class Weapon {
    constructor(game, id) { this.game = game; this.id = id; this.level = 1; this.maxLevel = 7; this.mul = Meta.weaponDamageMul(id); }
    /** Анимация атаки героя — только от его стартового оружия, чтобы не дёргался от каждого выстрела. */
    animate(dur) { const p = this.game.player; if (p.hero.weapon === this.id) p.swing(dur); }
    update() {}
    draw() {}
    glow() {}
    nextLevelText() { return ''; }
  }

  /** Магический снаряд в ближайшего врага. */
  class BoltWeapon extends Weapon {
    constructor(game) { super(game, 'bolt'); this.timer = 0.3; }
    static damage(l) { return 10 + 5 * (l - 1); }
    static cooldown(l) { return 0.65 * Math.pow(0.88, l - 1); }
    static count(l) { return 1 + Math.floor(l / 2); }
    static pierce(l) { return 1 + Math.floor((l - 1) / 3); }
    static info(l) { const S = BoltWeapon; return { dmg: S.damage(l), cd: S.cooldown(l), range: 460, extra: S.count(l) + ' снаряд(а), пробивает ' + S.pierce(l) }; }
    update(dt) {
      if ((this.timer -= dt) > 0) return;
      const g = this.game, p = g.player, L = this.level, S = BoltWeapon;
      const target = g.findNearestEnemy(p.x, p.y, 460);
      if (!target) { this.timer = 0.1; return; }
      this.timer = S.cooldown(L);
      const ty = target === g.boss ? target.y - target.h * 0.35 : target.y - 6;
      const base = Math.atan2(ty - (p.y - 8), target.x - p.x), n = S.count(L);
      p.aimAt(target.x - p.x);
      this.animate(0.3);
      for (let k = 0; k < n; k++) {
        const a = base + (k - (n - 1) / 2) * 0.14;
        g.spawnProjectile(0, p.x, p.y - 8, Math.cos(a) * 330, Math.sin(a) * 330, S.damage(L) * this.mul, S.pierce(L), 1.3);
      }
      Sfx.play('shoot');
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = BoltWeapon, parts = ['Урон ' + S.damage(a) + '→' + S.damage(b)];
      if (S.count(b) > S.count(a)) parts.push('+1 снаряд');
      if (S.pierce(b) > S.pierce(a)) parts.push('пробивает +1 врага');
      parts.push('перезарядка −12%');
      return parts.join(', ');
    }
  }

  /** Удар мечом (базовая атака рыцаря): дуга перед героем, с 4-го уровня — второй удар за спину. */
  class SwordWeapon extends Weapon {
    constructor(game) { super(game, 'sword'); this.timer = 0.3; this.queue = []; this.slashes = []; }
    static damage(l) { return 16 + 7 * (l - 1); }
    static cooldown(l) { return 0.9 * Math.pow(0.92, l - 1); }
    static radius(l) { return 38 + 3 * (l - 1); }
    static backswing(l) { return l >= 4; }
    static info(l) { const S = SwordWeapon; return { dmg: S.damage(l), cd: S.cooldown(l), range: S.radius(l), extra: S.backswing(l) ? 'удар вперёд и с разворота назад' : 'удар дугой перед собой' }; }
    update(dt) {
      const g = this.game, p = g.player, L = this.level, S = SwordWeapon;
      // отложенные удары: урон приходится на фазу «удар» анимации, а не на замах
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const q = this.queue[i];
        if ((q.t -= dt) > 0) continue;
        this.queue.splice(i, 1);
        if (q.swing) { p.aimAt(q.dir * 10); this.animate(SWING_TIME); this.queue.push({ t: SWING_HIT, dir: q.dir }); continue; }
        this.strike(q.dir);
      }
      for (let i = this.slashes.length - 1; i >= 0; i--) if ((this.slashes[i].t += dt) > 0.24) this.slashes.splice(i, 1);
      if ((this.timer -= dt) > 0) return;
      const R = S.radius(L), target = g.findNearestEnemy(p.x, p.y, R + 14);
      if (!target) { this.timer = 0.08; return; }
      this.timer = S.cooldown(L);
      const dir = target.x >= p.x ? 1 : -1;
      p.aimAt(dir * 10);
      this.animate(SWING_TIME);
      this.queue.push({ t: SWING_HIT, dir });
      if (S.backswing(L)) this.queue.push({ t: SWING_TIME, dir: -dir, swing: true });
    }
    strike(dir) {
      const g = this.game, p = g.player, L = this.level, S = SwordWeapon;
      const R = S.radius(L), dmg = S.damage(L) * this.mul, items = g.enemies.items, cy = p.y - 8;
      for (let i = 0; i < g.enemies.count; i++) {
        const e = items[i];
        if (!e.alive) continue;
        const dx = e.x - p.x, dy = (e.y - 4) - cy;
        if (dx * dir < -8) continue;
        const rr = R + e.r, ey = dy / 0.82;
        if (dx * dx + ey * ey > rr * rr) continue;
        const d = Math.hypot(dx, dy) || 1;
        g.damageEnemy(e, dmg, dx / d * 170, dy / d * 170);
      }
      if (g.boss.alive && g.bossHitTest(p.x + dir * R * 0.55, cy, R * 0.6)) g.damageBoss(dmg);
      this.slashes.push({ dir, t: 0 });
      Sfx.play('slash');
    }
    draw(ctx, ox, oy) {
      if (!this.slashes.length) return;
      const p = this.game.player, fr = Sprites.get('slash').anims.idle, k = SwordWeapon.radius(this.level) / 38;
      for (const s of this.slashes) {
        const f = fr[Math.min(2, (s.t / 0.08) | 0)], w = Math.round(f.w * k), h = Math.round(f.h * k);
        const x = Math.round(p.x - ox), y = Math.round(p.y - 8 - oy - f.ay * k);
        if (s.dir > 0) ctx.drawImage(Sprites.atlas, f.x, f.y, f.w, f.h, x - Math.round(f.ax * k), y, w, h);
        else {
          ctx.setTransform(-1, 0, 0, 1, x + Math.round(f.ax * k), y);
          ctx.drawImage(Sprites.atlas, f.x, f.y, f.w, f.h, 0, 0, w, h);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
    }
    glow(ctx, ox, oy, g) {
      const p = this.game.player, R = SwordWeapon.radius(this.level);
      for (const s of this.slashes) g.glowAt(ctx, 'ice', p.x + s.dir * R * 0.75 - ox, p.y - 8 - oy, R * 0.8, 0.35 * (1 - s.t / 0.24));
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = SwordWeapon, parts = ['Урон ' + S.damage(a) + '→' + S.damage(b)];
      if (S.backswing(b) && !S.backswing(a)) parts.push('удар с разворота назад');
      parts.push('шире и чаще');
      return parts.join(', ');
    }
  }
  const SWING_TIME = 0.27, SWING_HIT = 0.08;

  /** Клинки, вращающиеся вокруг героя. */
  class OrbitWeapon extends Weapon {
    constructor(game) { super(game, 'orbit'); this.angle = 0; }
    static count(l) { return 2 + Math.floor((l - 1) / 2); }
    static damage(l) { return 8 + 4 * (l - 1); }
    static radius(l) { return 40 + 4 * (l - 1); }
    static spin(l) { return 2.8 + 0.25 * (l - 1); }
    static info(l) { const S = OrbitWeapon; return { dmg: S.damage(l), cd: 0.4, range: S.radius(l), extra: S.count(l) + ' клинка вокруг героя' }; }
    update(dt) {
      const g = this.game, p = g.player, L = this.level, S = OrbitWeapon;
      this.angle += S.spin(L) * dt;
      const n = S.count(L), R = S.radius(L), br = 7, dmg = S.damage(L) * this.mul;
      const items = g.enemies.items, grid = g.grid, res = grid.result, now = g.time;
      for (let b = 0; b < n; b++) {
        const a = this.angle + b * TAU / n, bx = p.x + Math.cos(a) * R, by = p.y - 6 + Math.sin(a) * R * 0.8;
        const m = grid.query(bx, by, br + MAX_ENEMY_R);
        for (let j = 0; j < m; j++) {
          const e = items[res[j]];
          if (!e.alive || now - e.orbitHit < 0.4) continue;
          const dx = e.x - bx, dy = e.y - 4 - by, rr = br + e.r;
          if (dx * dx + dy * dy > rr * rr) continue;
          e.orbitHit = now;
          const ex = e.x - p.x, ey = e.y - p.y, d = Math.hypot(ex, ey) || 1;
          g.damageEnemy(e, dmg, ex / d * 110, ey / d * 110);
        }
        const bo = g.boss;
        if (bo.alive && now - bo.orbitHit > 0.4 && g.bossHitTest(bx, by, br)) {
          bo.orbitHit = now;
          g.damageBoss(dmg);
        }
      }
    }
    draw(ctx, ox, oy) {
      const fr = Sprites.get('blade').anims.idle, f = fr[((this.game.time * 16) | 0) % fr.length];
      const p = this.game.player, L = this.level, S = OrbitWeapon, n = S.count(L), R = S.radius(L);
      for (let b = 0; b < n; b++) {
        const a = this.angle + b * TAU / n;
        Sprites.draw(ctx, f, p.x + Math.cos(a) * R - ox, p.y - 6 + Math.sin(a) * R * 0.8 - oy, false, false);
      }
    }
    glow(ctx, ox, oy, g) {
      const p = this.game.player, L = this.level, S = OrbitWeapon, n = S.count(L), R = S.radius(L);
      for (let b = 0; b < n; b++) {
        const a = this.angle + b * TAU / n;
        g.glowAt(ctx, 'ice', p.x + Math.cos(a) * R - ox, p.y - 6 + Math.sin(a) * R * 0.8 - oy, 11, 0.6);
      }
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = OrbitWeapon, parts = ['Урон ' + S.damage(a) + '→' + S.damage(b)];
      if (S.count(b) > S.count(a)) parts.push('+1 клинок');
      parts.push('шире и быстрее');
      return parts.join(', ');
    }
  }

  /** Волна света вокруг героя. */
  class NovaWeapon extends Weapon {
    constructor(game) { super(game, 'nova'); this.timer = 1; }
    static cooldown(l) { return 3.2 * Math.pow(0.9, l - 1); }
    static radius(l) { return 72 + 11 * (l - 1); }
    static damage(l) { return 20 + 9 * (l - 1); }
    static info(l) { const S = NovaWeapon; return { dmg: S.damage(l), cd: S.cooldown(l), range: S.radius(l), extra: 'бьёт всех вокруг и отбрасывает' }; }
    update(dt) {
      if ((this.timer -= dt) > 0) return;
      const g = this.game, p = g.player, L = this.level, S = NovaWeapon;
      this.timer = S.cooldown(L);
      const R = S.radius(L), dmg = S.damage(L) * this.mul, items = g.enemies.items;
      for (let i = 0; i < g.enemies.count; i++) {
        const e = items[i];
        if (!e.alive) continue;
        const dx = e.x - p.x, dy = e.y - p.y, rr = R + e.r, d2 = dx * dx + dy * dy;
        if (d2 > rr * rr) continue;
        const d = Math.sqrt(d2) || 1;
        g.damageEnemy(e, dmg, dx / d * 200, dy / d * 200);
      }
      if (g.boss.alive && g.bossHitTest(p.x, p.y, R)) g.damageBoss(dmg);
      g.spawnRing(p.x, p.y - 4, R, 'gold');
      this.animate(0.45);
      Sfx.play('nova');
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = NovaWeapon;
      return 'Урон ' + S.damage(a) + '→' + S.damage(b) + ', радиус +' + (S.radius(b) - S.radius(a)) + ', чаще на 10%';
    }
  }

  /** Стрелы в ближайшего врага, пробивающие насквозь. */
  class ArrowWeapon extends Weapon {
    constructor(game) { super(game, 'arrows'); this.timer = 0.2; }
    static damage(l) { return 12 + 5 * (l - 1); }
    static cooldown(l) { return 0.5 * Math.pow(0.9, l - 1); }
    static count(l) { return 1 + Math.floor(l / 3); }
    static pierce(l) { return 2 + Math.floor(l / 3); }
    static info(l) { const S = ArrowWeapon; return { dmg: S.damage(l), cd: S.cooldown(l), range: 420, extra: S.count(l) + ' стрел(а), пробивает ' + S.pierce(l) }; }
    update(dt) {
      if ((this.timer -= dt) > 0) return;
      const g = this.game, p = g.player, L = this.level, S = ArrowWeapon;
      const target = g.findNearestEnemy(p.x, p.y, 420);
      if (!target) { this.timer = 0.1; return; }
      this.timer = S.cooldown(L);
      const ty = target === g.boss ? target.y - target.h * 0.35 : target.y - 6 * target.scale;
      const base = Math.atan2(ty - (p.y - 9), target.x - p.x), n = S.count(L);
      p.aimAt(target.x - p.x);
      this.animate(0.3);
      for (let k = 0; k < n; k++) {
        const a = base + (k - (n - 1) / 2) * 0.12;
        g.spawnProjectile(1, p.x, p.y - 9, Math.cos(a) * 380, Math.sin(a) * 380, S.damage(L) * this.mul, S.pierce(L), 0.9);
      }
      Sfx.play('arrow');
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = ArrowWeapon, parts = ['Урон ' + S.damage(a) + '→' + S.damage(b)];
      if (S.count(b) > S.count(a)) parts.push('+1 стрела');
      if (S.pierce(b) > S.pierce(a)) parts.push('пробивает +1');
      parts.push('стреляет чаще');
      return parts.join(', ');
    }
  }

  /** Редкое оружие из сундука: молния перескакивает между врагами. */
  class LightningWeapon extends Weapon {
    constructor(game) { super(game, 'lightning'); this.timer = 0.5; }
    static damage(l) { return 18 + 7 * (l - 1); }
    static cooldown(l) { return 1.5 * Math.pow(0.9, l - 1); }
    static chain(l) { return 3 + l; }
    static info(l) { const S = LightningWeapon; return { dmg: S.damage(l), cd: S.cooldown(l), range: 220, extra: 'перескакивает на ' + S.chain(l) + ' врагов' }; }
    update(dt) {
      if ((this.timer -= dt) > 0) return;
      const g = this.game, p = g.player, L = this.level, S = LightningWeapon;
      let cur = g.findNearestEnemy(p.x, p.y, 220);
      if (!cur) { this.timer = 0.15; return; }
      this.timer = S.cooldown(L);
      let px = p.x, py = p.y - 10;
      const dmg = S.damage(L) * this.mul, stamp = ++g.chainStamp;
      p.aimAt(cur.x - p.x);
      Sfx.play('zap');
      for (let k = 0; k < S.chain(L) && cur; k++) {
        const cy = cur === g.boss ? cur.y - cur.h * 0.4 : cur.y - 6;
        g.spawnBolt(px, py, cur.x, cy);
        px = cur.x; py = cy;
        cur.chain = stamp;
        if (cur === g.boss) g.damageBoss(dmg); else g.damageEnemy(cur, dmg, 0, 0);
        cur = g.findNearestUnchained(px, py, 80, stamp);
      }
    }
    nextLevelText() {
      const a = this.level, b = a + 1, S = LightningWeapon;
      return 'Урон ' + S.damage(a) + '→' + S.damage(b) + ', +1 перескок, чаще на 10%';
    }
  }

  // signature — именное оружие героя: только стартовое, в выборе «Новое!» не предлагается
  const WEAPON_DEFS = [
    { id: 'sword', name: 'Удар мечом', icon: 'sword', signature: true, desc: 'Рубит дугой врагов перед собой.', cls: SwordWeapon, make: (g) => new SwordWeapon(g) },
    { id: 'bolt', name: 'Магический снаряд', icon: 'bolt', desc: 'Стреляет в ближайшего врага.', cls: BoltWeapon, make: (g) => new BoltWeapon(g) },
    { id: 'orbit', name: 'Кружащие клинки', icon: 'orbit', desc: 'Клинки вращаются вокруг тебя.', cls: OrbitWeapon, make: (g) => new OrbitWeapon(g) },
    { id: 'nova', name: 'Волна света', icon: 'nova', desc: 'Периодически бьёт всех вокруг и отбрасывает.', cls: NovaWeapon, make: (g) => new NovaWeapon(g) },
    { id: 'arrows', name: 'Ливень стрел', icon: 'arrows', desc: 'Стреляет в ближайшего врага, пробивая насквозь.', cls: ArrowWeapon, make: (g) => new ArrowWeapon(g) },
    { id: 'lightning', name: 'Цепная молния', icon: 'lightning', rare: true, desc: 'Редкое: молния перескакивает между врагами.', cls: LightningWeapon, make: (g) => new LightningWeapon(g) },
  ];
  window.WEAPONS = WEAPON_DEFS;   // для Арсенала в меню
  function weaponDef(id) { for (const d of WEAPON_DEFS) if (d.id === id) return d; return null; }

  // =====================================================================
  // Upgrades — выбор «1 из 3» (аллокации только при повышении уровня)
  // =====================================================================
  const PASSIVES = [
    { id: 'speed', name: 'Лёгкие сапоги', icon: 'speed', max: 5, desc: 'Скорость передвижения +12%', apply: (p) => { p.speedMul += 0.12; } },
    { id: 'hp', name: 'Крепкое сердце', icon: 'hp', max: 5, desc: 'Макс. здоровье +25 и лечение на 25', apply: (p) => { p.maxHp += 25; p.hp = Math.min(p.maxHp, p.hp + 25); } },
    { id: 'magnet', name: 'Магнит', icon: 'magnet', max: 5, desc: 'Радиус сбора опыта +35%', apply: (p) => { p.magnetMul += 0.35; } },
    { id: 'might', name: 'Сила', icon: 'might', max: 5, desc: 'Весь урон +12%', apply: (p) => { p.damageMul += 0.12; } },
  ];

  class Upgrades {
    constructor(game) { this.game = game; }
    all() {
      const g = this.game, p = g.player, opts = [];
      for (const w of g.weapons) {
        if (w.level >= w.maxLevel) continue;
        const def = weaponDef(w.id);
        opts.push({ icon: def.icon, title: def.name, tag: 'Ур. ' + (w.level + 1), isNew: false, desc: w.nextLevelText(), apply: () => { w.level++; } });
      }
      for (const def of WEAPON_DEFS) {
        if (def.signature || (def.rare && !Meta.weaponFound(def.id)) || g.weapons.some((w) => w.id === def.id)) continue;
        opts.push({ icon: def.icon, title: def.name, tag: 'Новое!', isNew: true, desc: def.desc, apply: () => { g.weapons.push(def.make(g)); } });
      }
      for (const ps of PASSIVES) {
        const lvl = p.passives[ps.id];
        if (lvl >= ps.max) continue;
        opts.push({ icon: ps.icon, title: ps.name, tag: 'Ур. ' + (lvl + 1), isNew: false, desc: ps.desc, apply: () => { p.passives[ps.id]++; ps.apply(p); } });
      }
      for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = opts[i]; opts[i] = opts[j]; opts[j] = t; }
      return opts;
    }
    roll(count) {
      const picked = this.all().slice(0, count);
      if (!picked.length) picked.push(this.heal());
      return picked;
    }
    heal() {
      const p = this.game.player;
      return { icon: 'food', title: 'Перекус', tag: '', isNew: false, desc: 'Восстановить 40 здоровья', apply: () => { p.hp = Math.min(p.maxHp, p.hp + 40); } };
    }
    /** Награда сундука: редкое оружие (если ещё нет) и улучшения сразу — всего 3. */
    chest() {
      const g = this.game, out = [];
      if (!g.weapons.some((w) => w.id === 'lightning')) {
        const def = weaponDef('lightning');
        out.push({ icon: def.icon, title: def.name, tag: 'Редкое!', isNew: true, desc: def.desc, apply: () => { g.weapons.push(def.make(g)); g.runStats.lightning = true; } });
      }
      // разные улучшения: не больше одного на одно оружие/пассивку
      for (const o of this.all()) { if (out.length >= 3) break; out.push(o); }
      if (out.length < 3) out.push(this.heal());
      return out;
    }
  }

  // =====================================================================
  // Spawner — темп, открытие новых мобов, элиты, рои и боссы по таймеру
  // =====================================================================
  class Spawner {
    constructor(game) {
      this.game = game;
      this.types = Object.keys(window.ENEMIES).map((id) => Object.assign({ id }, window.ENEMIES[id]));
      this.reset();
    }
    reset() { this.acc = 0; this.nextSwarm = 50; this.bossIndex = 0; this.nextBoss = window.BOSSES[0].time; this.warned = false; this.loop = 0; }
    get hpMul() { const m = this.game.time / 60; return 1 + m * 0.45 + m * m * 0.12; }
    get speedMul() { return 1 + Math.min(0.3, this.game.time / 900); }
    rate() { const t = this.game.time; return 0.8 + t * 0.02 + (t * t) / 3600 * 0.4; }
    pickType() {
      const t = this.game.time;
      let total = 0;
      for (const d of this.types) if (d.unlock <= t) total += d.weight;
      let r = Math.random() * total;
      for (const d of this.types) {
        if (d.unlock > t) continue;
        if ((r -= d.weight) <= 0) return d.id;
      }
      return 'ghoul';
    }
    eliteChance() { const t = this.game.time; return t < 90 ? 0 : Math.min(0.06, 0.012 + (t - 90) / 6000); }

    update(dt) {
      const g = this.game, bossMul = g.boss.alive ? 0.4 : 1;
      this.acc += this.rate() * bossMul * g.run.spawn * dt;
      while (this.acc >= 1) {
        this.acc -= 1;
        const type = this.pickType();
        this.spawnAround(type, Math.random() * TAU, window.ENEMIES[type].elite && Math.random() < this.eliteChance());
      }
      if (g.time >= this.nextSwarm) {
        this.nextSwarm += 50;
        const type = g.time > window.ENEMIES.bat.unlock ? 'bat' : 'ghoul';
        const n = 18 + Math.floor(g.time / 30) * 2, off = Math.random() * TAU;
        for (let i = 0; i < n; i++) this.spawnAround(type, off + i * TAU / n, false);
        g.showBanner('Рой приближается!', '#ff8a5a');
      }
      // боссы по таймеру
      const B = window.BOSSES;
      if (!this.warned && g.time >= this.nextBoss - 4 && !g.boss.alive) {
        this.warned = true;
        g.announceBoss(B[this.bossIndex % B.length]);
      }
      if (this.warned && g.time >= this.nextBoss && !g.boss.alive) {
        const def = B[this.bossIndex % B.length];
        g.spawnBoss(def, 1 + this.loop * window.BOSS_LOOP.hpGrowth);
        this.bossIndex++;
        if (this.bossIndex % B.length === 0) this.loop++;
        this.nextBoss = this.bossIndex < B.length ? B[this.bossIndex].time : this.nextBoss + window.BOSS_LOOP.every;
        this.warned = false;
      }
    }
    spawnAround(type, angle, elite) {
      const g = this.game, p = g.player;
      for (let tries = 0; tries < 3; tries++) {
        const d = g.spawnDist + rand(0, 40), x = p.x + Math.cos(angle) * d, y = p.y + Math.sin(angle) * d;
        if (window.ENEMIES[type].flying || g.world.isFree(x, y, 10)) { g.spawnEnemy(type, x, y, elite); return; }
        angle += 0.4;
      }
    }
  }

  // =====================================================================
  // Boss — одна активная туша; способности из behaviors.js
  // =====================================================================
  class Boss {
    constructor() {
      this.alive = false; this.dk = DK_BOSS; this.uid = -1;
      this.marks = new Float32Array(24); this.markCount = 0;
      this.def = null; this.h = 1; this.chain = 0;
    }
    init(def, hpMul, x, y) {
      this.def = def; this.alive = true;
      this.spr = Sprites.get(def.sprite);
      this.h = this.spr.anims.walk[0].h; this.x = x; this.y = y; this.r = def.r;
      this.hp = this.maxHp = def.hp * hpMul;
      this.vx = 0; this.vy = 0; this.ax = 1; this.ay = 0;
      this.phase = 0; this.state = 'enter'; this.timer = 1.6; this.actT = 0;
      this.abilityIndex = 0; this.ability = null;
      this.flash = 0; this.invuln = 0; this.orbitHit = -10; this.animT = 0;
      this.dashing = false; this.dashDmg = 0; this.dashHit = false; this.spin = 0; this.emit = 0;
      this.glowHex = GLOW_HEX[def.glow]; this.flipX = false;
    }
    get phaseDef() { return this.def.phases[this.phase]; }
  }

  // =====================================================================
  // UI — DOM-экраны и HUD
  // =====================================================================
  /**
   * Внутриигровой UI: HUD, выбор улучшения, сундук, пауза, итоги забега, галерея.
   * Главное меню и его разделы — в menu.js (Menu).
   */
  class UI {
    constructor(game) {
      this.game = game;
      const $ = (id) => document.getElementById(id);
      this.$ = $;
      this.screens = {
        levelup: $('screen-levelup'), pause: $('screen-pause'),
        over: $('screen-over'), chest: $('screen-chest'), gallery: $('screen-gallery'),
      };
      this.pauseBtn = $('btn-pause');
      this.safeEl = $('safe');
      $('btn-retry').addEventListener('click', () => game.start());
      $('btn-menu').addEventListener('click', () => game.toMenu());
      $('btn-resume').addEventListener('click', () => game.resume());
      $('btn-quit').addEventListener('click', () => game.toMenu());
      $('btn-gallery-close').addEventListener('click', () => this.show(null, true));
      this.pauseBtn.addEventListener('click', () => game.pause());
      // переключатели звука на паузе
      this.pauseMusic = $('pause-music'); this.pauseSfx = $('pause-sfx');
      this.pauseMusic.addEventListener('click', () => { Music.setEnabled(!Music.enabled); this.paintPauseToggles(); });
      this.pauseSfx.addEventListener('click', () => { Sfx.setEnabled(!Sfx.enabled); this.paintPauseToggles(); Sfx.play('click'); });
      this.secShown = -1; this.timeStr = '00:00';
      this.killsShown = -1; this.killStr = '';
      this.levelShown = -1; this.levelStr = '';
      this.safeTop = 0;
      this.galleryBuilt = false;
    }
    paintPauseToggles() {
      this.pauseMusic.textContent = 'Музыка: ' + (Music.enabled ? 'вкл' : 'выкл');
      this.pauseSfx.textContent = 'Звуки: ' + (Sfx.enabled ? 'вкл' : 'выкл');
      this.pauseMusic.setAttribute('aria-pressed', String(Music.enabled));
      this.pauseSfx.setAttribute('aria-pressed', String(Sfx.enabled));
    }
    /** Пиксельная иконка из атласа в отдельный канвас. */
    paintIcon(canvas, name, scale) { this.paintFrame(canvas, Sprites.get('icon_' + name).anims.idle[0], scale); return canvas; }
    readSafeArea() { this.safeTop = parseFloat(getComputedStyle(this.safeEl).paddingTop) || 0; }
    /** Показать экран забега (или ни одного). keepHud=true — не показывать кнопку паузы (в меню). */
    show(name, keepHud) {
      for (const k in this.screens) this.screens[k].hidden = k !== name;
      this.pauseBtn.hidden = name !== null || !!keepHud || this.game.state !== 'play';
      if (name === 'pause') this.paintPauseToggles();
    }

    /** Рисует кадр атласа в DOM-канвас с целым увеличением. */
    paintFrame(canvas, frame, scale) {
      canvas.width = frame.w * scale; canvas.height = frame.h * scale;
      const c = canvas.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.drawImage(Sprites.atlas, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w * scale, frame.h * scale);
    }

    cards(container, options, onPick) {
      container.textContent = '';
      const buttons = [];
      for (const o of options) {
        const b = document.createElement(onPick ? 'button' : 'div');
        b.className = 'card';
        if (onPick) b.disabled = true;
        b.innerHTML = '<div class="icon"></div><div><div class="title">' + o.title +
          (o.tag ? '<span class="tag' + (o.isNew ? ' new' : '') + '">' + o.tag + '</span>' : '') +
          '</div><div class="desc">' + o.desc + '</div></div>';
        b.firstChild.appendChild(this.paintIcon(document.createElement('canvas'), o.icon, 3));
        if (onPick) { b.addEventListener('click', () => onPick(o)); buttons.push(b); }
        container.appendChild(b);
      }
      if (onPick) setTimeout(() => { for (const b of buttons) b.disabled = false; }, 350);
    }
    showLevelUp(options, onPick) { this.cards(this.$('choices'), options, onPick); this.show('levelup'); }
    showChest(options, onTake) {
      this.cards(this.$('chest-items'), options, null);
      const btn = this.$('btn-chest');
      btn.disabled = true;
      btn.onclick = () => onTake();
      setTimeout(() => { btn.disabled = false; }, 400);
      this.show('chest');
    }
    showOver(time, kills, level, best, isRecord, reward) {
      const box = this.$('run-reward');
      box.textContent = '';
      if (reward) {
        const total = document.createElement('div'); total.className = 'total';
        total.appendChild(this.paintIcon(document.createElement('canvas'), 'ash', 2));
        total.appendChild(document.createTextNode('+' + reward.total));
        box.appendChild(total);
        const parts = document.createElement('div');
        parts.textContent = reward.parts.map((p) => p[0] + ' +' + p[1]).join(' · ') + (reward.bonusPct ? ' · бонус +' + reward.bonusPct + '%' : '');
        box.appendChild(parts);
        const lines = reward.completed.map((t) => 'Задание выполнено: ' + t)
          .concat(reward.achievements.map((t) => 'Достижение: ' + t));
        if (reward.accountLevel) lines.push('Уровень аккаунта ' + reward.accountLevel + '!');
        for (const t of lines) {
          const q = document.createElement('div'); q.className = 'quest'; q.textContent = t;
          box.appendChild(q);
        }
      }
      this.$('stat-time').textContent = formatTime(time);
      this.$('stat-kills').textContent = String(kills);
      this.$('stat-level').textContent = String(level);
      this.$('stat-best').textContent = isRecord ? 'Новый рекорд!' : 'Рекорд: ' + formatTime(best);
      this.show('over');
    }

    /** Галерея всех процедурных спрайтов, тайлов и палитры. */
    showGallery() {
      if (!this.galleryBuilt) { this.buildGallery(); this.galleryBuilt = true; }
      this.show('gallery');
      this.$('gallery').scrollTop = 0;
    }
    buildGallery() {
      const wrap = this.$('gallery');
      wrap.textContent = '';
      const items = ['gem1', 'gem2', 'gem3', 'bolt', 'blade', 'arrow', 'bonearrow', 'fireball', 'acid', 'chest'];
      const groups = [
        ['Герои', (n) => n.startsWith('hero_')],
        ['Мобы', (n) => window.ENEMIES[n] !== undefined || (n.endsWith('_elite') && window.ENEMIES[n.slice(0, -6)])],
        ['Боссы', (n) => window.BOSSES.some((b) => b.sprite === n)],
        ['Декорации', (n) => n.startsWith('decor_')],
        ['Предметы и снаряды', (n) => items.indexOf(n) >= 0],
        ['Иконки', (n) => n.startsWith('icon_')],
      ];
      const names = Sprites.names();
      for (const [title, test] of groups) {
        const h = document.createElement('h3'); h.textContent = title; wrap.appendChild(h);
        const row = document.createElement('div'); row.className = 'gallery-row'; wrap.appendChild(row);
        for (const n of names) {
          if (!test(n)) continue;
          const spr = Sprites.get(n);
          const cell = document.createElement('div'); cell.className = 'gallery-cell';
          const frames = document.createElement('div'); frames.className = 'gallery-frames';
          const first = spr.anims[Object.keys(spr.anims)[0]][0];
          const scale = first.h > 60 ? 2 : first.h < 20 ? 4 : 3;
          for (const a in spr.anims) {
            const list = spr.anims[a], step = list.length > 8 ? 4 : 1;
            for (let i = 0; i < list.length; i += step) {
              const cv = document.createElement('canvas');
              this.paintFrame(cv, list[i], scale);
              frames.appendChild(cv);
            }
          }
          const label = document.createElement('div'); label.className = 'gallery-label';
          const base = n.replace('_elite', '');
          const mob = window.ENEMIES[base];
          const boss = window.BOSSES.find((b) => b.sprite === n);
          const hero = window.HEROES.find((x) => x.sprite === n);
          label.textContent = hero ? hero.name + ' — ' + hero.title
            : boss ? boss.name
            : mob ? mob.name + (n.endsWith('_elite') ? ' · элита' : '')
            : n.replace('decor_', '');
          cell.appendChild(frames); cell.appendChild(label); row.appendChild(cell);
        }
      }
      const h = document.createElement('h3'); h.textContent = 'Тайлы земли 32×32'; wrap.appendChild(h);
      const row = document.createElement('div'); row.className = 'gallery-row'; wrap.appendChild(row);
      for (const kind of ['grass', 'dirt', 'stone']) {
        for (const tile of Sprites.tiles[kind]) {
          const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
          const c = cv.getContext('2d'), img = c.createImageData(32, 32), d = new Uint32Array(img.data.buffer);
          for (let i = 0; i < 1024; i++) d[i] = window.Palette.rgba[tile.ramp[tile.tone[i]]];
          c.putImageData(img, 0, 0);
          cv.className = 'tile';
          row.appendChild(cv);
        }
      }
      const hp = document.createElement('h3'); hp.textContent = 'Палитра: ' + window.Palette.size + ' цветов'; wrap.appendChild(hp);
      const pal = document.createElement('div'); pal.className = 'palette'; wrap.appendChild(pal);
      for (let i = 1; i < window.Palette.colors.length; i++) {
        const s = document.createElement('span'); s.style.background = window.Palette.colors[i]; pal.appendChild(s);
      }
    }

    drawHUD(ctx, w, h) {
      const g = this.game, p = g.player;
      const top = this.safeTop + 10, pad = 12;
      const bw = w - pad * 2, bh = 12;
      ctx.fillStyle = '#0d0a14';
      ctx.fillRect(pad - 2, top - 2, bw + 4, bh + 4);
      ctx.fillStyle = '#22346e';
      ctx.fillRect(pad, top, bw, bh);
      const xw = Math.round(bw * clamp(p.xp / p.xpNext, 0, 1));
      ctx.fillStyle = '#3a92b0'; ctx.fillRect(pad, top, xw, bh);
      ctx.fillStyle = '#78d0e0'; ctx.fillRect(pad, top, xw, 4);

      const sec = Math.floor(g.time);
      if (sec !== this.secShown) { this.secShown = sec; this.timeStr = formatTime(sec); }
      if (g.kills !== this.killsShown) { this.killsShown = g.kills; this.killStr = String(g.kills); this.killW = -1; }
      if (p.level !== this.levelShown) { this.levelShown = p.level; this.levelStr = 'УР.' + p.level; }
      const ty = top + bh + 12;
      ctx.textBaseline = 'top';
      ctx.font = '13px ' + FONT;
      this.text(ctx, this.levelStr, pad, ty + 3, 'left', '#f4c95a');
      this.text(ctx, this.killStr, w - pad, ty + 3, 'right', '#e8e0c4');
      const sk = this.skull || (this.skull = Sprites.get('icon_skull').anims.idle[0]);
      ctx.imageSmoothingEnabled = false;
      if (this.killW < 0) this.killW = ctx.measureText(this.killStr).width;
      ctx.drawImage(Sprites.atlas, sk.x, sk.y, 16, 16, Math.round(w - pad - this.killW - 20), ty, 16, 16);
      ctx.font = '18px ' + FONT;
      this.text(ctx, this.timeStr, w / 2, ty, 'center', '#ffffff');

      // полоса босса
      const b = g.boss;
      if (b.alive) {
        const by = ty + 64, bw2 = Math.min(w - 40, 420), bx = (w - bw2) / 2;
        ctx.font = '11px ' + FONT;
        this.text(ctx, b.def.name, w / 2, by - 18, 'center', b.phase ? '#f5856a' : '#e8e0c4');
        ctx.fillStyle = '#0d0a14'; ctx.fillRect(bx - 2, by - 2, bw2 + 4, 14);
        ctx.fillStyle = '#3a0c14'; ctx.fillRect(bx, by, bw2, 10);
        const hw = Math.round(bw2 * clamp(b.hp / b.maxHp, 0, 1));
        ctx.fillStyle = b.invuln > 0 ? '#78d0e0' : '#a8262c'; ctx.fillRect(bx, by, hw, 10);
        ctx.fillStyle = b.invuln > 0 ? '#d0f6ff' : '#dc4a3a'; ctx.fillRect(bx, by, hw, 3);
        ctx.fillStyle = '#f4c95a'; ctx.fillRect(bx + bw2 / 2 - 1, by - 2, 2, 14);
      }
      if (g.bannerTime > 0) {
        ctx.globalAlpha = clamp(g.bannerTime, 0, 1);
        ctx.font = '13px ' + FONT;
        this.text(ctx, g.bannerText, w / 2, h * 0.3, 'center', g.bannerColor);
        ctx.globalAlpha = 1;
      }
    }
    text(ctx, s, x, y, align, color) {
      ctx.textAlign = align;
      ctx.fillStyle = '#0d0a14';
      ctx.fillText(s, x + 2, y + 2);
      ctx.fillStyle = color;
      ctx.fillText(s, x, y);
    }
  }

  // =====================================================================
  // Game
  // =====================================================================
  class Game {
    constructor(canvas) {
      Sprites.init();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.view = document.createElement('canvas');
      this.vctx = this.view.getContext('2d', { alpha: false });
      this.vignette = document.createElement('canvas');

      this.input = new Input(canvas);
      this.player = new Player();
      this.boss = new Boss();
      this.chest = { alive: false, dk: DK_CHEST, x: 0, y: 0, open: false, t: 0 };
      this.enemies = new Pool(Enemy, MAX_ENEMIES);
      this.projectiles = new Pool(Projectile, MAX_PROJ);
      this.shots = new Pool(Shot, MAX_SHOTS);
      this.gems = new Pool(Gem, MAX_GEMS);
      this.particles = new Pool(Particle, MAX_PARTICLES);
      this.rings = new Pool(Ring, MAX_RINGS);
      this.zones = new Pool(Zone, MAX_ZONES);
      this.bolts = new Pool(Bolt, MAX_BOLTS);
      this.nums = new Pool(DmgNum, MAX_NUMS);
      this.digits = buildDigits();
      this.grid = new SpatialGrid(GRID_CELL, MAX_ENEMIES);
      this.drawList = [];
      this.spawner = new Spawner(this);
      this.upgrades = new Upgrades(this);
      this.ui = new UI(this);
      this.worlds = {};            // карта → World (чанки остаются в кэше между забегами)
      this.world = null; this.ambient = AMBIENT;
      this.run = { hp: 1, dmg: 1, speed: 1, spawn: 1 };

      this.state = 'menu';
      this.weapons = [];
      this.time = 0; this.kills = 0; this.uid = 0; this.chainStamp = 0;
      this.pendingLevels = 0; this.levelUpId = 0;
      this.bannerText = ''; this.bannerTime = 0; this.bannerColor = '#fff';
      this.shakeAmt = 0; this.bossWarnT = 0; this.hitstop = 0;
      this.runStats = { elites: 0, bosses: 0, gems: 0, byType: {}, bossIds: [], lightning: false };
      this.w = 1; this.h = 1; this.dpr = 1; this.k = 1; this.bw = 1; this.bh = 1; this.spawnDist = 300;

      this.resize = this.resize.bind(this);
      window.addEventListener('resize', this.resize);
      window.addEventListener('orientationchange', () => setTimeout(this.resize, 200));
      if (window.visualViewport) window.visualViewport.addEventListener('resize', this.resize);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
      document.addEventListener('gesturestart', (e) => e.preventDefault());
      document.addEventListener('dblclick', (e) => e.preventDefault());
      document.addEventListener('contextmenu', (e) => e.preventDefault());
      // скролл разрешён только внутри прокручиваемых экранов
      document.addEventListener('touchmove', (e) => {
        if (!(e.target.closest && e.target.closest('.scroll'))) e.preventDefault();
      }, { passive: false });

      this.resize();
      this.resetWorld();
      this.menu = new Menu(this);
      this.menu.open('main');
      if (document.fonts && document.fonts.load) document.fonts.load('12px "Press Start 2P"').catch(() => {});

      this.last = performance.now();
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    // ---------- Экран: целый множитель пикселя и буфер низкого разрешения ----------
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = window.innerWidth, h = window.innerHeight;
      this.dpr = dpr; this.w = w; this.h = h;
      const dw = Math.round(w * dpr), dh = Math.round(h * dpr);
      this.canvas.width = dw; this.canvas.height = dh;
      this.k = Math.max(1, Math.round(Math.min(dw, dh) / ART_SHORT));
      this.bw = Math.ceil(dw / this.k); this.bh = Math.ceil(dh / this.k);
      this.view.width = this.bw; this.view.height = this.bh;
      this.vctx.imageSmoothingEnabled = false;
      this.spawnDist = Math.hypot(this.bw, this.bh) / 2 + 30;
      this.buildVignette();
      this.ui.readSafeArea();
    }
    buildVignette() {
      const c = this.vignette, w = this.bw, h = this.bh;
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const r = Math.hypot(w, h) / 2;
      const grd = g.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
      grd.addColorStop(0, 'rgba(13,10,20,0)');
      grd.addColorStop(0.7, 'rgba(13,10,20,0.35)');
      grd.addColorStop(1, 'rgba(13,10,20,0.8)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }

    // ---------- Состояния ----------
    /** Условия забега из подготовки (Meta.sel): герой, карта, сложность, модификаторы. */
    resetWorld() {
      const sel = Meta.sel;
      let hero = window.HEROES.find((h) => h.id === sel.hero);
      if (!hero || !Meta.isUnlocked(hero)) hero = window.HEROES[0];
      let map = window.MAPS.find((m) => m.id === sel.map);
      if (!map || !Meta.isUnlocked(map)) map = window.MAPS[0];
      let dif = window.DIFFICULTIES.find((d) => d.id === sel.difficulty);
      if (!dif || !Meta.isUnlocked(dif)) dif = window.DIFFICULTIES[0];
      const mods = sel.mods.filter((id) => window.MODIFIERS.some((m) => m.id === id));
      this.run = {
        map: map.id, difficulty: dif.id, mods,
        hp: dif.hp, dmg: dif.dmg,
        speed: mods.indexOf('haste') >= 0 ? 1.2 : 1,
        spawn: mods.indexOf('horde') >= 0 ? 1.5 : 1,
      };
      this.world = this.worlds[map.id] || (this.worlds[map.id] = new World(map.seed, map.world));
      this.ambient = map.ambient;
      this.enemies.clear(); this.projectiles.clear(); this.shots.clear(); this.gems.clear();
      this.particles.clear(); this.rings.clear(); this.zones.clear(); this.bolts.clear(); this.nums.clear();
      this.boss.alive = false; this.chest.alive = false;
      this.player.reset(hero);
      this.player.applyMeta(Meta.bonuses(hero.id));
      this.weapons = [weaponDef(hero.weapon).make(this)];
      this.weapons[0].level += Meta.weaponBonus(hero.id);
      if (mods.indexOf('glass') >= 0) { const p = this.player; p.damageMul *= 1.5; p.maxHp = Math.round(p.maxHp * 0.5); p.hp = p.maxHp; }
      this.runStats = { elites: 0, bosses: 0, gems: 0, byType: {}, bossIds: [], lightning: false };
      this.spawner.reset();
      this.time = 0; this.kills = 0; this.pendingLevels = 0; this.bannerTime = 0; this.shakeAmt = 0; this.bossWarnT = 0; this.hitstop = 0;
      this.input.reset();
    }
    start() {
      this.resetWorld();
      this.lowQ = Settings.quality === 'low';
      this.state = 'play';
      this.ui.show(null);
      this.menu.close();
      this.last = performance.now();
    }
    toMenu() {
      // выход из забега через паузу — награда всё равно начисляется
      const res = this.state === 'paused' ? this.finishRun() : null;
      this.state = 'menu';
      this.ui.show(null, true);
      this.menu.open('main', res);
    }
    finishRun() {
      const rs = this.runStats;
      return Meta.finishRun(this.player.hero.id, {
        kills: this.kills, time: this.time, level: this.player.level,
        elites: rs.elites, bosses: rs.bosses, gems: rs.gems, byType: rs.byType, bossIds: rs.bossIds, lightning: rs.lightning,
      }, this.run);
    }
    get bestTime() { return loadNum(BEST_KEY); }
    pause() { if (this.state !== 'play') return; this.state = 'paused'; this.input.reset(); this.ui.show('pause'); }
    resume() { if (this.state !== 'paused') return; this.state = 'play'; this.ui.show(null); }
    openLevelUp() {
      this.state = 'levelup';
      Sfx.play('levelup');
      Settings.vibrate(15);
      this.input.reset();
      const id = ++this.levelUpId;
      this.ui.showLevelUp(this.upgrades.roll(Math.random() < this.player.luck ? 4 : 3), (opt) => {
        if (this.state !== 'levelup' || id !== this.levelUpId) return;
        opt.apply();
        Sfx.play('click');
        this.pendingLevels--;
        if (this.pendingLevels > 0) this.openLevelUp();
        else { this.state = 'play'; this.ui.show(null); }
      });
    }
    openChest() {
      this.state = 'chest';
      this.input.reset();
      const rewards = this.upgrades.chest();
      for (const r of rewards) r.apply();
      this.ui.showChest(rewards, () => {
        if (this.state !== 'chest') return;
        this.state = 'play'; this.ui.show(null);
      });
    }
    gameOver() {
      this.state = 'over';
      this.input.reset();
      const prev = loadNum(BEST_KEY), isRecord = this.time > prev;
      if (isRecord) save(BEST_KEY, this.time);
      this.ui.showOver(this.time, this.kills, this.player.level, Math.max(prev, this.time), isRecord, this.finishRun());
    }
    showBanner(text, color) { this.bannerText = text; this.bannerTime = 2.8; this.bannerColor = color || '#ffffff'; }
    shake(n) { if (n > this.shakeAmt) this.shakeAmt = n; }
    /** Короткая заморозка кадра — вес сильным ударам. */
    freeze(t) { if (t > this.hitstop) this.hitstop = t; }
    spawnNumber(x, y, value, color) {
      const v = Math.round(value);
      if (v < 1) return;
      const n = this.nums.obtain();
      if (!n) return;
      n.x = x + rand(-4, 4); n.y = y; n.value = v > 9999 ? 9999 : v; n.life = 0.6; n.color = color;
    }

    // ---------- Фабрики ----------
    spawnEnemy(type, x, y, elite) {
      const e = this.enemies.obtain();
      if (!e) return null;
      const d = window.ENEMIES[type], E = window.ELITE, sp = this.spawner;
      const s = elite ? E.scale : 1;
      e.def = d; e.beh = window.EnemyBehaviors[d.behavior]; e.spr = Sprites.get(d.sprite + (elite ? '_elite' : ''));
      e.uid = ++this.uid; e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.kx = 0; e.ky = 0;
      e.elite = elite; e.scale = s; e.r = d.r * s;
      const run = this.run;
      e.hp = e.maxHp = d.hp * sp.hpMul * run.hp * (elite ? E.hp : 1);
      e.speed = d.speed * sp.speedMul * run.speed * rand(0.9, 1.1) * (elite ? E.speed : 1);
      e.dmgMul = (1 + (sp.hpMul - 1) * 0.15) * run.dmg * (elite ? E.dmg : 1);
      e.dmg = d.dmg * e.dmgMul;
      e.xp = d.xp * (elite ? E.xp : 1);
      e.flash = 0; e.orbitHit = -10; e.animT = Math.random(); e.chain = 0;
      e.state = 0; e.timer = 0; e.cd = Math.random(); e.tele = false; e.seed = Math.random();
      e.dirX = 1; e.dirY = 0;
      return e;
    }
    spawnProjectile(kind, x, y, vx, vy, dmg, pierce, life) {
      const p = this.projectiles.obtain();
      if (!p) return;
      p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.dmg = dmg; p.pierce = pierce; p.life = life;
      p.r = kind === 1 ? 3 : 4; p.hitCount = 0;
    }
    spawnEnemyProjectile(x, y, vx, vy, dmg, sprite, glow) {
      const s = this.shots.obtain();
      if (!s) return;
      s.x = x; s.y = y; s.vx = vx; s.vy = vy; s.dmg = dmg; s.life = 4.5;
      s.spr = Sprites.get(sprite); s.glow = glow || 'red'; s.r = 3;
      Sfx.play('eshot');
    }
    spawnGem(x, y, value) {
      const gm = this.gems.obtain();
      if (!gm) { this.gems.items[(Math.random() * this.gems.count) | 0].value += value; return; }
      gm.x = x + rand(-3, 3); gm.y = y + rand(-3, 3); gm.value = value; gm.attract = false; gm.spd = 0; gm.seed = Math.random() * 10;
    }
    spawnParticles(x, y, color, n) {
      if (this.lowQ) n = (n + 1) >> 1;
      for (let i = 0; i < n; i++) {
        const pt = this.particles.obtain();
        if (!pt) return;
        const a = Math.random() * TAU, s = rand(30, 90);
        pt.x = x; pt.y = y; pt.z = rand(2, 10); pt.vx = Math.cos(a) * s; pt.vy = Math.sin(a) * s * 0.6; pt.vz = rand(30, 90);
        pt.life = pt.maxLife = rand(0.35, 0.7); pt.size = Math.random() < 0.3 ? 2 : 1; pt.color = color;
      }
    }
    spawnRing(x, y, r, glow) {
      const o = this.rings.obtain();
      if (!o) return;
      o.x = x; o.y = y; o.r = r; o.t = 0; o.dur = 0.35; o.hex = GLOW_HEX[glow] || glow;
    }
    spawnZone(x, y, r, warn, dur, dps, color) {
      const z = this.zones.obtain();
      if (!z) return;
      z.x = x; z.y = y; z.r = r; z.warn = warn; z.dur = dur; z.t = 0; z.dps = dps; z.hex = GLOW_HEX[color] || color;
    }
    spawnBolt(x0, y0, x1, y1) {
      const b = this.bolts.obtain();
      if (!b) return;
      b.x0 = x0; b.y0 = y0; b.x1 = x1; b.y1 = y1; b.life = 0.16;
    }
    explode(x, y, r, dmg) {
      const p = this.player, dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy < r * r) this.hurtPlayer(dmg);
      this.spawnRing(x, y, r, 'fire');
      this.spawnParticles(x, y, '#ec6a14', 10);
      this.shake(3);
      Sfx.play('boom');
    }

    // ---------- Бой ----------
    findNearestEnemy(x, y, maxDist) {
      const items = this.enemies.items;
      let best = null, bestD = maxDist * maxDist;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (!e.alive) continue;
        const dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = e; }
      }
      const b = this.boss;
      if (b.alive && b.state !== 'enter') {
        const dx = b.x - x, dy = b.y - y, d2 = dx * dx + dy * dy;
        if (d2 < bestD) best = b;
      }
      return best;
    }
    findNearestUnchained(x, y, maxDist, stamp) {
      const items = this.enemies.items;
      let best = null, bestD = maxDist * maxDist;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (!e.alive || e.chain === stamp) continue;
        const dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = e; }
      }
      return best;
    }
    damageEnemy(e, amount, kx, ky) {
      if (!e.alive) return;
      const dmg = amount * this.player.damageMul;
      e.hp -= dmg;
      e.flash = 0.08;
      this.spawnNumber(e.x, e.y - 14 * e.scale, dmg, NUM_WHITE);
      Sfx.play('hit');
      e.kx += kx * e.def.knockRes; e.ky += ky * e.def.knockRes;
      if (e.hp <= 0) this.killEnemy(e);
    }
    killEnemy(e) {
      if (!e.alive) return;
      e.alive = false;
      this.kills++;
      const bt = this.runStats.byType; bt[e.def.sprite] = (bt[e.def.sprite] || 0) + 1;
      Sfx.play(e.elite ? 'elite' : 'kill');
      if (e.elite) { this.freeze(0.06); this.runStats.elites++; }
      this.spawnGem(e.x, e.y, e.xp);
      this.spawnParticles(e.x, e.y - 6, e.def.color, e.elite ? 16 : 6);
      if (e.elite) { this.spawnRing(e.x, e.y - 6, 26, 'gold'); for (let i = 0; i < 3; i++) this.spawnGem(e.x, e.y, 3); }
      const od = e.def.onDeath;
      if (od) for (let i = 0; i < od.count; i++) {
        const a = i / od.count * TAU;
        this.spawnEnemy(od.split, e.x + Math.cos(a) * 6, e.y + Math.sin(a) * 6, false);
      }
    }
    bossHitTest(x, y, r) {
      const b = this.boss;
      if (!b.alive || b.state === 'enter') return false;
      const dx = b.x - x, dy = b.y - b.h * 0.35 - y, rr = r + b.r * 1.3;
      return dx * dx + dy * dy < rr * rr;
    }
    damageBoss(amount) {
      const b = this.boss;
      if (!b.alive || b.invuln > 0 || b.state === 'enter') return;
      const dmg = amount * this.player.damageMul;
      b.hp -= dmg;
      b.flash = 0.06;
      this.spawnNumber(b.x, b.y - b.h * 0.75, dmg, NUM_GOLD);
      Sfx.play('hit');
      const ph = b.def.phases;
      if (b.phase + 1 < ph.length && b.hp <= b.maxHp * ph[b.phase + 1].at) {
        b.phase++;
        b.abilityIndex = 0;
        this.showBanner(b.phaseDef.roar || 'Босс в ярости!', '#f5856a');
        this.spawnRing(b.x, b.y - b.h * 0.4, 60, 'red');
        this.shake(5);
        this.freeze(0.15);
        Sfx.play('roar');
      }
      if (b.hp <= 0) this.killBoss();
    }
    killBoss() {
      const b = this.boss;
      b.alive = false;
      this.kills++;
      this.shake(8);
      this.freeze(0.3);
      Sfx.play('bossdie');
      this.runStats.bosses++;
      this.runStats.bossIds.push(b.def.id);
      for (let i = 0; i < 4; i++) this.spawnRing(b.x, b.y - b.h * 0.4, 30 + i * 25, i % 2 ? 'gold' : b.def.glow);
      for (let i = 0; i < 40; i++) this.spawnParticles(b.x + rand(-20, 20), b.y - rand(0, b.h * 0.7), i % 2 ? b.def.color : '#f4c95a', 1);
      for (let i = 0; i < 12; i++) this.spawnGem(b.x + rand(-25, 25), b.y + rand(-15, 15), 10);
      const c = this.chest;
      c.alive = true; c.open = false; c.t = 0; c.x = b.x; c.y = b.y;
      for (let k = 0; k < 8 && !this.world.isFree(c.x, c.y, 10); k++) c.y += 12;
      this.showBanner('Победа! Открой сундук', '#f4c95a');
    }
    announceBoss(def) {
      this.bossWarnT = 4;
      Sfx.play('warn');
      this.showBanner('Приближается: ' + def.name, '#f5856a');
    }
    spawnBoss(def, hpMul) {
      const p = this.player, a = Math.random() * TAU;
      this.boss.init(def, hpMul * this.run.hp, p.x + Math.cos(a) * 110, p.y + Math.sin(a) * 80);
      this.spawnRing(this.boss.x, this.boss.y, 50, def.glow);
      this.shake(6);
      Sfx.play('roar');
    }
    hurtPlayer(dmg) {
      const p = this.player;
      if (p.iframes > 0 || this.state !== 'play') return;
      const taken = Math.max(1, dmg - p.armor);
      p.hp -= taken;
      p.iframes = 0.45; p.hurtT = 0.22;
      this.shake(2);
      this.freeze(0.04);
      this.spawnNumber(p.x, p.y - 30, taken, NUM_RED);
      Sfx.play('hurt');
      Settings.vibrate(25);
    }
    addXp(v) {
      const p = this.player;
      p.xp += v * p.xpMul * XP_RATE;
      while (p.xp >= p.xpNext) { p.xp -= p.xpNext; p.level++; p.xpNext = xpForLevel(p.level); this.pendingLevels++; }
    }

    // ---------- Цикл ----------
    frame(now) {
      requestAnimationFrame(this.frame);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const st = this.state;
      Music.setMode(st === 'menu' || st === 'over' ? 'menu' : this.boss.alive || this.bossWarnT > 0 ? 'boss' : 'run');
      Music.duck(st === 'paused' || st === 'levelup' || st === 'chest');
      if (st === 'menu') return;   // меню рисует свой фон (menu.js)
      if (this.state === 'play') {
        if (this.hitstop > 0) this.hitstop -= dt;
        else this.update(dt);
      }
      else if (this.state === 'dying') this.updateDying(dt);
      this.render();
    }

    update(dt) {
      const p = this.player;
      this.time += dt;
      if (this.bannerTime > 0) this.bannerTime -= dt;
      if (this.bossWarnT > 0) this.bossWarnT -= dt;

      this.input.update();
      this.updatePlayer(dt);
      this.spawner.update(dt);
      this.updateEnemies(dt);
      this.grid.build(this.enemies);
      this.separateEnemies();
      this.updateBoss(dt);
      for (let i = 0; i < this.weapons.length; i++) this.weapons[i].update(dt);
      this.updateProjectiles(dt);
      this.updateShots(dt);
      this.updateZones(dt);
      this.updateContact();
      this.updateGems(dt);
      this.updateChest(dt);
      this.updateEffects(dt);

      this.enemies.sweep(); this.projectiles.sweep(); this.shots.sweep(); this.gems.sweep();
      this.particles.sweep(); this.rings.sweep(); this.zones.sweep(); this.bolts.sweep(); this.nums.sweep();

      if (this.state !== 'play') return;   // открылся сундук
      if (p.hp <= 0) { Sfx.play('death'); p.hp = 0; this.state = 'dying'; p.deathT = 0.001; this.input.reset(); this.ui.pauseBtn.hidden = true; return; }
      if (this.pendingLevels > 0) this.openLevelUp();
    }
    updateDying(dt) {
      const p = this.player;
      p.deathT += dt;
      this.updateEffects(dt);
      this.particles.sweep(); this.rings.sweep(); this.bolts.sweep(); this.nums.sweep();
      if (p.deathT > 1.4) this.gameOver();
    }

    updatePlayer(dt) {
      const p = this.player, inp = this.input;
      const mx = inp.dx, my = inp.dy;
      p.moving = mx !== 0 || my !== 0;
      if (p.moving) {
        const len = Math.hypot(mx, my);
        p.dirX = mx / len; p.dirY = my / len;
      }
      // взгляд: в сторону последнего выстрела, иначе на ближайшего врага рядом, иначе по ходу движения
      if (p.atkT > 0) p.atkT = Math.max(0, p.atkT - dt);
      if (p.aimT > 0) { p.aimT -= dt; p.facing = p.aimFacing; }
      else {
        const near = this.findNearestEnemy(p.x, p.y, 140);
        if (near && Math.abs(near.x - p.x) > 2) p.facing = near.x > p.x ? 1 : -1;
        else if (Math.abs(mx) > 0.15) p.facing = mx > 0 ? 1 : -1;
      }
      const s = p.speed;
      p.x += (mx * s + p.extVX + p.knockX) * dt;
      p.y += (my * s + p.extVY + p.knockY) * dt;
      p.extVX = 0; p.extVY = 0;
      const decay = Math.exp(-7 * dt);
      p.knockX *= decay; p.knockY *= decay;
      this.world.resolve(p, p.r);
      this.world.resolve(p, p.r);
      if (p.regen > 0) p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
      if (p.iframes > 0) p.iframes -= dt;
      if (p.hurtT > 0) p.hurtT -= dt;
      p.animT += dt;
    }

    updateEnemies(dt) {
      const p = this.player, items = this.enemies.items, world = this.world;
      const decay = Math.exp(-8 * dt);
      const far = this.spawnDist * 1.6, far2 = far * far;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (!e.alive) continue;
        const dx = p.x - e.x, dy = p.y - e.y;
        if (dx * dx + dy * dy > far2) {
          // отстал — переносим вперёд по ходу движения героя
          const a = p.moving ? Math.atan2(p.dirY, p.dirX) + rand(-0.9, 0.9) : Math.random() * TAU;
          const nx = p.x + Math.cos(a) * this.spawnDist, ny = p.y + Math.sin(a) * this.spawnDist;
          if (e.def.flying || world.isFree(nx, ny, e.r)) { e.x = nx; e.y = ny; }
          continue;
        }
        e.beh.update(e, this, dt, e.def.params);
        if (!e.alive) continue;
        e.x += (e.vx + e.kx) * dt;
        e.y += (e.vy + e.ky) * dt;
        e.kx *= decay; e.ky *= decay;
        if (!e.def.flying) world.resolve(e, e.r);
        if (e.flash > 0) e.flash -= dt;
        e.animT += dt;
      }
    }

    separateEnemies() {
      const items = this.enemies.items, grid = this.grid, res = grid.result;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (!e.alive) continue;
        const m = grid.query(e.x, e.y, e.r + MAX_ENEMY_R);
        for (let j = 0; j < m; j++) {
          const idx = res[j];
          if (idx === i) continue;
          const o = items[idx];
          if (!o.def || o.def.flying !== e.def.flying) continue;
          const dx = e.x - o.x, dy = e.y - o.y, rr = e.r + o.r, d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 < 0.0001) continue;
          const d = Math.sqrt(d2), push = (rr - d) / d * 0.5 * (o.r / rr);
          e.x += dx * push; e.y += dy * push;
        }
      }
    }

    updateBoss(dt) {
      const b = this.boss;
      if (!b.alive) return;
      const p = this.player, ph = b.phaseDef, spd = b.def.speed * (ph.speedMul || 1);
      b.animT += dt;
      if (b.flash > 0) b.flash -= dt;
      if (b.invuln > 0) b.invuln -= dt;
      const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) || 1;
      if (Math.abs(dx) > 4) b.flipX = dx < 0;

      if (b.state === 'enter') {
        if ((b.timer -= dt) <= 0) { b.state = 'idle'; b.timer = 1; }
        if (Math.random() < 0.6) this.spawnParticles(b.x + rand(-20, 20), b.y, b.glowHex, 1);
        return;
      }
      if (b.state === 'idle') {
        // далеко отстал — догоняет быстрее, чтобы бой не «терялся» за экраном
        const catchUp = d > this.spawnDist * 0.55 ? 3 : 1;
        b.vx = dx / d * spd * catchUp; b.vy = dy / d * spd * catchUp;
        if (d < b.r + 14) { b.vx = 0; b.vy = 0; }
        if ((b.timer -= dt) <= 0) {
          const list = ph.abilities;
          b.ability = list[b.abilityIndex % list.length];
          b.abilityIndex++;
          window.BossAbilities[b.ability.use].start(b, this, b.ability);
          b.state = 'windup'; b.timer = b.ability.windup;
        }
      } else if (b.state === 'windup') {
        b.vx = 0; b.vy = 0;
        if ((b.timer -= dt) <= 0) { b.state = 'act'; b.actT = 0; }
      } else if (b.state === 'act') {
        const done = window.BossAbilities[b.ability.use].act(b, this, b.ability, dt);
        b.actT += dt;
        if (done) { b.state = 'idle'; b.timer = ph.pause; b.dashing = false; }
      }
      b.x += b.vx * dt; b.y += b.vy * dt;
      // касание
      const cr = b.r + p.r, cdx = p.x - b.x, cdy = p.y - b.y;
      if (cdx * cdx + cdy * cdy < cr * cr) {
        if (b.dashing && !b.dashHit) { b.dashHit = true; this.hurtPlayer(b.dashDmg); p.knockX += b.ax * 200; p.knockY += b.ay * 200; }
        else this.hurtPlayer(b.def.dmg * this.run.dmg);
      }
    }

    updateProjectiles(dt) {
      const items = this.projectiles.items, en = this.enemies.items, grid = this.grid, res = grid.result, boss = this.boss;
      for (let i = 0; i < this.projectiles.count; i++) {
        const pr = items[i];
        if (!pr.alive) continue;
        pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        if ((pr.life -= dt) <= 0) { pr.alive = false; continue; }
        const m = grid.query(pr.x, pr.y + 6, pr.r + MAX_ENEMY_R);
        for (let j = 0; j < m; j++) {
          const e = en[res[j]];
          if (!e.alive) continue;
          const dx = e.x - pr.x, dy = e.y - 6 * e.scale - pr.y, rr = pr.r + e.r;
          if (dx * dx + dy * dy > rr * rr || pr.hasHit(e.uid)) continue;
          pr.addHit(e.uid);
          const v = Math.hypot(pr.vx, pr.vy) || 1;
          this.damageEnemy(e, pr.dmg, pr.vx / v * 80, pr.vy / v * 80);
          if (--pr.pierce <= 0) { pr.alive = false; break; }
        }
        if (pr.alive && boss.alive && !pr.hasHit(-1) && this.bossHitTest(pr.x, pr.y, pr.r)) {
          pr.addHit(-1);
          this.damageBoss(pr.dmg);
          if (--pr.pierce <= 0) pr.alive = false;
        }
      }
    }

    updateShots(dt) {
      const items = this.shots.items, p = this.player;
      for (let i = 0; i < this.shots.count; i++) {
        const s = items[i];
        s.x += s.vx * dt; s.y += s.vy * dt;
        if ((s.life -= dt) <= 0) { s.alive = false; continue; }
        const dx = p.x - s.x, dy = p.y - 7 - s.y, rr = s.r + p.r;
        if (dx * dx + dy * dy < rr * rr) { this.hurtPlayer(s.dmg); s.alive = false; }
      }
    }

    updateZones(dt) {
      const items = this.zones.items, p = this.player;
      for (let i = 0; i < this.zones.count; i++) {
        const z = items[i];
        z.t += dt;
        if (z.t > z.warn + z.dur) { z.alive = false; continue; }
        if (z.t > z.warn) {
          const dx = p.x - z.x, dy = (p.y - z.y) / 0.75;
          if (dx * dx + dy * dy < z.r * z.r) this.hurtPlayer(z.dps * 0.45);
        }
      }
    }

    updateContact() {
      const p = this.player, items = this.enemies.items, res = this.grid.result;
      if (p.iframes > 0) return;
      const m = this.grid.query(p.x, p.y, p.r + MAX_ENEMY_R);
      for (let j = 0; j < m; j++) {
        const e = items[res[j]];
        if (!e.alive) continue;
        const dx = e.x - p.x, dy = e.y - p.y, rr = p.r + e.r;
        if (dx * dx + dy * dy < rr * rr) { this.hurtPlayer(e.dmg); return; }
      }
    }

    updateGems(dt) {
      const p = this.player, items = this.gems.items;
      const mr = p.magnet, mr2 = mr * mr, cr = p.r + 4;
      const lost = this.spawnDist * 3, lost2 = lost * lost;
      for (let i = 0; i < this.gems.count; i++) {
        const gm = items[i];
        const dx = p.x - gm.x, dy = p.y - 4 - gm.y, d2 = dx * dx + dy * dy;
        if (!gm.attract) {
          if (d2 < mr2) { gm.attract = true; gm.spd = 30; }
          else if (d2 > lost2) gm.alive = false;
          continue;
        }
        gm.spd += 700 * dt;
        const d = Math.sqrt(d2), step = gm.spd * dt;
        if (d <= cr + step) { gm.alive = false; this.addXp(gm.value); this.runStats.gems++; Sfx.play('gem'); continue; }
        gm.x += dx / d * step; gm.y += dy / d * step;
      }
    }

    updateChest(dt) {
      const c = this.chest, p = this.player;
      if (!c.alive) return;
      c.t += dt;
      if (c.open) { if (c.t > 6) c.alive = false; return; }
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy < 16 * 16) {
        c.open = true; c.t = 0;
        this.spawnRing(c.x, c.y - 8, 40, 'gold');
        this.spawnParticles(c.x, c.y - 8, '#f4c95a', 16);
        Sfx.play('chest');
        this.openChest();
      }
    }

    updateEffects(dt) {
      const ps = this.particles.items;
      for (let i = 0; i < this.particles.count; i++) {
        const pt = ps[i];
        if ((pt.life -= dt) <= 0) { pt.alive = false; continue; }
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.vz -= 260 * dt; pt.z += pt.vz * dt;
        if (pt.z < 0) { pt.z = 0; pt.vz *= -0.35; pt.vx *= 0.6; pt.vy *= 0.6; }
      }
      const rs = this.rings.items;
      for (let i = 0; i < this.rings.count; i++) { const r = rs[i]; if ((r.t += dt) >= r.dur) r.alive = false; }
      const bs = this.bolts.items;
      for (let i = 0; i < this.bolts.count; i++) { const b = bs[i]; if ((b.life -= dt) <= 0) b.alive = false; }
      const ns = this.nums.items;
      for (let i = 0; i < this.nums.count; i++) { const n = ns[i]; if ((n.life -= dt) <= 0) n.alive = false; else n.y -= 30 * n.life * dt * 2; }
      if (this.shakeAmt > 0) this.shakeAmt = Math.max(0, this.shakeAmt - dt * 20);
    }

    // =================================================================
    // Рендер
    // =================================================================
    glowAt(ctx, name, x, y, radius, alpha) {
      ctx.globalAlpha = alpha;
      const d = radius * 2;
      ctx.drawImage(Sprites.glow[name], Math.round(x - radius), Math.round(y - radius), d, d);
    }

    render() {
      const ctx = this.vctx, p = this.player, bw = this.bw, bh = this.bh;
      // камера: целые пиксели и лёгкая тряска
      let sx = 0, sy = 0;
      if (this.shakeAmt > 0) { sx = Math.round(rand(-1, 1) * this.shakeAmt); sy = Math.round(rand(-1, 1) * this.shakeAmt); }
      const L = Math.round(p.x - bw / 2) + sx, T = Math.round(p.y - bh / 2) + sy, R = L + bw, B = T + bh;

      this.world.update(L, T, R, B);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0d0a14';
      ctx.fillRect(0, 0, bw, bh);
      this.world.drawGround(ctx, L, T, R, B);

      this.drawZonesBase(ctx, L, T);
      const decor = this.world.collectDecor(L, T, R, B);
      this.drawShadows(ctx, decor, L, T, R, B);
      this.drawGems(ctx, L, T, R, B);
      this.drawSorted(ctx, decor, L, T, R, B);
      this.drawProjectiles(ctx, L, T);
      this.drawParticles(ctx, L, T);

      // ночь: multiply-тон, затем всё светящееся в режиме 'lighter'
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = this.ambient;
      ctx.fillRect(0, 0, bw, bh);
      ctx.globalCompositeOperation = 'lighter';
      this.drawLights(ctx, L, T, R, B);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.vignette, 0, 0);
      this.drawNumbers(ctx, L, T);
      if (this.bossWarnT > 0) {
        ctx.globalAlpha = 0.5 * Math.abs(Math.sin(this.bossWarnT * 5));
        ctx.fillStyle = '#a8262c';
        ctx.fillRect(0, 0, bw, 4); ctx.fillRect(0, bh - 4, bw, 4); ctx.fillRect(0, 0, 4, bh); ctx.fillRect(bw - 4, 0, 4, bh);
      }
      if (p.hurtT > 0) {
        ctx.globalAlpha = p.hurtT * 1.1;
        ctx.fillStyle = '#a8262c';
        ctx.fillRect(0, 0, bw, bh);
      }
      ctx.globalAlpha = 1;

      // на экран: целый множитель, без сглаживания
      const main = this.ctx;
      main.setTransform(1, 0, 0, 1, 0, 0);
      main.imageSmoothingEnabled = false;
      main.drawImage(this.view, 0, 0, bw * this.k, bh * this.k);
      main.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.state === 'play') this.drawJoystick(main);
      if (this.state !== 'menu') this.ui.drawHUD(main, this.w, this.h);
    }

    /** Всплывающий урон: поверх ночи, чтобы читался. Без строк и аллокаций. */
    drawNumbers(ctx, L, T) {
      const ns = this.nums.items, dg = this.digits;
      for (let i = 0; i < this.nums.count; i++) {
        const n = ns[i], row = dg[n.color];
        ctx.globalAlpha = n.life < 0.2 ? n.life * 5 : 1;
        let v = n.value, digits = v >= 1000 ? 4 : v >= 100 ? 3 : v >= 10 ? 2 : 1;
        let x = Math.round(n.x - L + digits * 2 - 2);
        const y = Math.round(n.y - T);
        do { ctx.drawImage(row[v % 10], x, y); x -= 4; v = (v / 10) | 0; } while (v > 0);
      }
      ctx.globalAlpha = 1;
    }

    drawZonesBase(ctx, L, T) {
      const zs = this.zones.items;
      for (let i = 0; i < this.zones.count; i++) {
        const z = zs[i];
        ctx.globalAlpha = z.t > z.warn ? 0.45 : 0.12 + 0.25 * (z.t / z.warn);
        ctx.fillStyle = z.hex;
        ctx.beginPath();
        ctx.ellipse(z.x - L, z.y - T, z.r, z.r * 0.75, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawShadows(ctx, decor, L, T, R, B) {
      for (let i = 0; i < decor.length; i++) {
        const d = decor[i], sh = d.shadow;
        ctx.drawImage(sh, Math.round(d.x - L - sh.width / 2 + 2), Math.round(d.y - T - sh.height / 2));
      }
      const items = this.enemies.items;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (!e.alive || e.x < L - 20 || e.x > R + 20 || e.y < T - 10 || e.y > B + 40) continue;
        const sh = Sprites.shadow(e.r * 2.4);
        ctx.drawImage(sh, Math.round(e.x - L - sh.width / 2), Math.round(e.y - T - sh.height / 2));
      }
      const p = this.player;
      if (p.deathT === 0) {
        const sh = Sprites.shadow(16);
        ctx.drawImage(sh, Math.round(p.x - L - sh.width / 2), Math.round(p.y - T - sh.height / 2));
      }
      const b = this.boss;
      if (b.alive) {
        const sh = Sprites.shadow(b.r * 3);
        ctx.globalAlpha = b.state === 'enter' ? clamp(1 - b.timer / 1.6, 0, 1) : 1;
        ctx.drawImage(sh, Math.round(b.x - L - sh.width / 2), Math.round(b.y - T - sh.height / 2));
        ctx.globalAlpha = 1;
      }
      if (this.chest.alive) {
        const sh = Sprites.shadow(26);
        ctx.drawImage(sh, Math.round(this.chest.x - L - sh.width / 2), Math.round(this.chest.y - T - sh.height / 2));
      }
    }

    drawGems(ctx, L, T, R, B) {
      const items = this.gems.items, t = this.time;
      const g1 = Sprites.get('gem1').anims.idle, g2 = Sprites.get('gem2').anims.idle, g3 = Sprites.get('gem3').anims.idle;
      for (let i = 0; i < this.gems.count; i++) {
        const gm = items[i];
        if (gm.x < L - 8 || gm.x > R + 8 || gm.y < T - 8 || gm.y > B + 16) continue;
        const list = gm.value < 3 ? g1 : gm.value < 10 ? g2 : g3;
        const ph = (t * 1.5 + gm.seed) % 4;
        const f = list[ph < 3.4 ? 0 : ph < 3.6 ? 1 : ph < 3.8 ? 2 : 1];
        const bob = Math.round(Math.sin(t * 3 + gm.seed) * 1.5) - 2;
        Sprites.draw(ctx, f, gm.x - L, gm.y - T + bob, false, false);
      }
    }

    /** Сортировка по Y: персонажи заходят за деревья и выходят из-за них. */
    drawSorted(ctx, decor, L, T, R, B) {
      const list = this.drawList, p = this.player;
      list.length = 0;
      for (let i = 0; i < decor.length; i++) list.push(decor[i]);
      const items = this.enemies.items;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i];
        if (e.alive && e.x > L - 40 && e.x < R + 40 && e.y > T - 10 && e.y < B + 70) list.push(e);
      }
      list.push(p);
      if (this.boss.alive) list.push(this.boss);
      if (this.chest.alive) list.push(this.chest);
      // сортировка вставками: без аллокаций
      for (let i = 1; i < list.length; i++) {
        const o = list[i], y = o.y;
        let j = i - 1;
        while (j >= 0 && list[j].y > y) { list[j + 1] = list[j]; j--; }
        list[j + 1] = o;
      }
      const blink = ((this.time * 12) | 0) % 2 === 0;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        switch (o.dk) {
          case DK_DECOR: {
            // полупрозрачность, если герой стоит за объектом
            const f = o.frame;
            const behind = o.fade && p.y < o.y - 4 && p.y > o.y - f.h + 6 && Math.abs(p.x - o.x) < f.w / 2 - 2;
            if (behind) ctx.globalAlpha = 0.55;
            Sprites.draw(ctx, f, o.x - L, o.y - T, o.flip, false);
            ctx.globalAlpha = 1;
            break;
          }
          case DK_ENEMY: {
            const a = o.spr.anims, useAtk = o.tele && a.attack;
            const fr = useAtk ? a.attack : a.walk;
            const f = fr[((o.animT * (useAtk ? 8 : 7)) | 0) % fr.length];
            const hover = o.def.flying ? o.def.hover * o.scale + Math.round(Math.sin(o.animT * 4) * 1.5) : 0;
            if (o.def.alpha) ctx.globalAlpha = o.def.alpha;
            Sprites.draw(ctx, f, o.x - L, o.y - T - hover, o.dirX < 0, o.flash > 0 || (o.tele && blink));
            ctx.globalAlpha = 1;
            break;
          }
          case DK_PLAYER: {
            if (p.iframes > 0 && blink && p.deathT === 0) break;
            Sprites.draw(ctx, p.frame(), p.x - L, p.y - T, p.facing < 0, p.hurtT > 0.15);
            if (p.deathT === 0) this.drawPlayerHp(ctx, p.x - L, p.y - T);
            break;
          }
          case DK_BOSS: this.drawBoss(ctx, L, T, blink); break;
          case DK_CHEST: {
            const c = this.chest, f = Sprites.get('chest').anims[c.open ? 'open' : 'closed'][0];
            if (c.open) ctx.globalAlpha = clamp(1 - (c.t - 4) / 2, 0, 1);
            Sprites.draw(ctx, f, c.x - L, c.y - T + (c.open ? 0 : Math.round(Math.sin(this.time * 4))), false, false);
            ctx.globalAlpha = 1;
            break;
          }
        }
      }
    }

    drawPlayerHp(ctx, x, y) {
      const p = this.player, w = 20, bx = Math.round(x - w / 2), by = Math.round(y - 34);
      const ratio = clamp(p.hp / p.maxHp, 0, 1);
      ctx.fillStyle = '#0d0a14'; ctx.fillRect(bx - 1, by - 1, w + 2, 4);
      ctx.fillStyle = '#3a0c14'; ctx.fillRect(bx, by, w, 2);
      ctx.fillStyle = ratio < 0.3 ? '#dc4a3a' : '#7fd450'; ctx.fillRect(bx, by, Math.round(w * ratio), 2);
    }

    drawBoss(ctx, L, T, blink) {
      const b = this.boss, a = b.spr.anims;
      let f;
      if (b.state === 'windup') f = a.attack[0];
      else if (b.state === 'act') f = a.attack[1];
      else f = a.walk[((b.animT * 6) | 0) % a.walk.length];
      const hover = b.def.flying ? b.def.hover + Math.round(Math.sin(b.animT * 2.5) * 2) : 0;
      if (b.state === 'enter') ctx.globalAlpha = clamp(1 - b.timer / 1.6, 0, 1);
      Sprites.draw(ctx, f, b.x - L, b.y - T - hover, b.flipX, b.flash > 0 || (b.state === 'windup' && blink && b.timer < 0.3));
      ctx.globalAlpha = 1;
    }

    drawProjectiles(ctx, L, T) {
      const items = this.projectiles.items;
      const bolt = Sprites.get('bolt').anims.idle, arrow = Sprites.get('arrow').anims.idle, t = this.time;
      for (let i = 0; i < this.projectiles.count; i++) {
        const pr = items[i];
        if (!pr.alive) continue;
        let f;
        if (pr.kind === 1) f = arrow[(Math.round(Math.atan2(pr.vy, pr.vx) / (Math.PI / 8)) + 16) % 16];
        else f = bolt[((t * 10) | 0) % 2];
        Sprites.draw(ctx, f, pr.x - L, pr.y - T, false, false);
      }
      const ss = this.shots.items;
      for (let i = 0; i < this.shots.count; i++) {
        const s = ss[i], fr = s.spr.anims.idle;
        const f = fr.length === 16 ? fr[(Math.round(Math.atan2(s.vy, s.vx) / (Math.PI / 8)) + 16) % 16] : fr[((t * 8) | 0) % fr.length];
        Sprites.draw(ctx, f, s.x - L, s.y - T, false, false);
      }
      for (let i = 0; i < this.weapons.length; i++) this.weapons[i].draw(ctx, L, T);
    }

    drawParticles(ctx, L, T) {
      const ps = this.particles.items;
      let last = '';
      for (let i = 0; i < this.particles.count; i++) {
        const pt = ps[i];
        if (pt.color !== last) { ctx.fillStyle = pt.color; last = pt.color; }
        ctx.fillRect(Math.round(pt.x - L), Math.round(pt.y - T - pt.z), pt.size, pt.size);
      }
    }

    /** Свет: всё, что светится, рисуется в режиме 'lighter' поверх ночного тона. */
    drawLights(ctx, L, T, R, B) {
      const p = this.player, t = this.time;
      const lamp = p.hero.id === 'gravedigger' ? 1.25 : 1;
      this.glowAt(ctx, 'warm', p.x - L, p.y - T - 8, 70 * lamp, 0.13 * lamp + Math.sin(t * 7) * 0.01);
      this.glowAt(ctx, 'warm', p.x - L, p.y - T - 8, 26, 0.12);
      if (p.hero.id === 'witch') this.glowAt(ctx, 'ice', p.x - L + p.facing * 7, p.y - T - 26, 8, 0.6);
      if (p.hero.id === 'gravedigger') this.glowAt(ctx, 'fire', p.x - L + p.facing * 7, p.y - T - 7, 8, 0.6);
      const gs = this.gems.items, low = this.lowQ;
      for (let i = 0; i < this.gems.count && !low; i++) {
        const gm = gs[i];
        // мелкие кристаллы светятся только во время блика — меньше отрисовок
        if (gm.x < L || gm.x > R || gm.y < T || gm.y > B) continue;
        if (gm.value < 3 && (t * 1.5 + gm.seed) % 4 < 3.4) continue;
        this.glowAt(ctx, gm.value < 3 ? 'ice' : gm.value < 10 ? 'toxic' : 'red', gm.x - L, gm.y - T - 5, 7, 0.35 + 0.15 * Math.sin(t * 5 + gm.seed));
      }
      const es = this.enemies.items;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = es[i];
        if (!e.alive || e.x < L - 20 || e.x > R + 20 || e.y < T - 20 || e.y > B + 40) continue;
        if (low && !e.elite && !e.tele) continue;
        if (e.elite) this.glowAt(ctx, 'gold', e.x - L, e.y - T - 10 * e.scale, 20 * e.scale, 0.28 + 0.1 * Math.sin(t * 6 + e.seed * 9));
        if (e.tele) this.glowAt(ctx, 'red', e.x - L, e.y - T - 8, 12, 0.45);
        else if (e.def.sprite === 'ghost') this.glowAt(ctx, 'ice', e.x - L, e.y - T - 14, 14, 0.25);
        else if (e.def.sprite === 'imp') this.glowAt(ctx, 'fire', e.x - L, e.y - T - 9, 8, 0.3);
      }
      const ps = this.projectiles.items;
      for (let i = 0; i < this.projectiles.count; i++) {
        const pr = ps[i];
        if (!pr.alive) continue;
        this.glowAt(ctx, pr.kind === 1 ? 'warm' : 'purple', pr.x - L, pr.y - T, pr.kind === 1 ? 6 : 10, 0.55);
      }
      const ss = this.shots.items;
      for (let i = 0; i < this.shots.count; i++) { const s = ss[i]; this.glowAt(ctx, s.glow, s.x - L, s.y - T, 9, 0.6); }
      for (let i = 0; i < this.weapons.length; i++) this.weapons[i].glow(ctx, L, T, this);
      // кольца волн
      const rs = this.rings.items;
      ctx.lineWidth = 3;
      for (let i = 0; i < this.rings.count; i++) {
        const r = rs[i], k = r.t / r.dur, rad = r.r * (0.3 + 0.7 * k);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = r.hex;
        ctx.beginPath();
        ctx.ellipse(r.x - L, r.y - T, rad, rad * 0.8, 0, 0, TAU);
        ctx.stroke();
      }
      // молнии
      const bs = this.bolts.items;
      ctx.strokeStyle = '#d0f6ff';
      ctx.lineWidth = 1;
      for (let i = 0; i < this.bolts.count; i++) {
        const b = bs[i];
        ctx.globalAlpha = b.life / 0.16;
        ctx.beginPath();
        ctx.moveTo(b.x0 - L, b.y0 - T);
        for (let k = 1; k < 5; k++) {
          const u = k / 5;
          ctx.lineTo(b.x0 + (b.x1 - b.x0) * u - L + rand(-4, 4), b.y0 + (b.y1 - b.y0) * u - T + rand(-4, 4));
        }
        ctx.lineTo(b.x1 - L, b.y1 - T);
        ctx.stroke();
        this.glowAt(ctx, 'ice', b.x1 - L, b.y1 - T, 10, 0.6 * b.life / 0.16);
      }
      // зоны на земле: мигающая кромка предупреждения
      const zs = this.zones.items;
      ctx.lineWidth = 1;
      for (let i = 0; i < this.zones.count; i++) {
        const z = zs[i];
        ctx.globalAlpha = z.t > z.warn ? 0.5 : 0.4 + 0.4 * Math.abs(Math.sin(z.t * 14));
        ctx.strokeStyle = z.hex;
        ctx.beginPath();
        ctx.ellipse(z.x - L, z.y - T, z.r, z.r * 0.75, 0, 0, TAU);
        ctx.stroke();
      }
      // босс: аура, щит, предупреждения способностей
      const b = this.boss;
      if (b.alive) {
        const bx = b.x - L, by = b.y - T - b.h * 0.4;
        this.glowAt(ctx, b.phase ? 'red' : b.def.glow, bx, by, b.h * 0.7, 0.22 + 0.06 * Math.sin(t * 4));
        if (b.invuln > 0) {
          ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t * 10);
          ctx.strokeStyle = '#78d0e0'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(bx, by, b.r * 1.9, b.r * 2.1, 0, 0, TAU); ctx.stroke();
          this.glowAt(ctx, 'ice', bx, by, b.r * 2.2, 0.25);
        }
        if (b.state === 'windup') {
          const A = b.ability;
          window.BossAbilities[A.use].warn(ctx, b, this, A, 1 - b.timer / A.windup, L, T);
        }
      }
      if (this.chest.alive) this.glowAt(ctx, 'gold', this.chest.x - L, this.chest.y - T - 10, 26, 0.35 + 0.1 * Math.sin(t * 5));
      ctx.globalAlpha = 1;
    }

    drawJoystick(ctx) {
      const inp = this.input;
      if (!inp.active) return;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(inp.ox, inp.oy, inp.radius, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(232,224,196,0.3)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(inp.px, inp.py, 24, 0, TAU);
      ctx.fillStyle = 'rgba(232,224,196,0.35)'; ctx.fill();
    }
  }

  window.addEventListener('load', () => { window.game = new Game(document.getElementById('game')); });
})();
