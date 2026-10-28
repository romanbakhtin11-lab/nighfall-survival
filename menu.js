'use strict';
/*
 * Главное меню: верхняя панель, разделы с нижней навигацией, окна поверх,
 * анимированный фон (туман, пепел, руны, герой на постаменте).
 *
 * Разделы (нижняя панель): main · heroes · upgrades · arsenal · collection
 * Окна поверх:             prep · settings · daily · achievements · confirm
 *
 * Данные — heroes.js, items.js, enemies.js, bosses.js; прогресс — Meta; настройки — Settings.
 * DOM строится здесь целиком внутри #menu.
 */
(function () {
  const TAU = Math.PI * 2;

  /** Короткий конструктор DOM: h('div', 'cls', 'текст' | [дети]). */
  function h(tag, cls, content) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (typeof content === 'string') el.textContent = content;
    else if (content) for (const c of content) if (c) el.appendChild(c);
    return el;
  }
  function formatTime(sec) {
    const s = Math.floor(sec), m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function frameOf(name, anim) { const s = Sprites.get(name); return s.anims[anim || Object.keys(s.anims)[0]][0]; }

  /** Кадр атласа → канвас с целым увеличением. silhouette — тёмный силуэт (не открыто). */
  function paint(frame, scale, silhouette, crop) {
    const c = document.createElement('canvas');
    const sx = crop ? crop[0] : 0, sy = crop ? crop[1] : 0, w = crop ? crop[2] : frame.w, hh = crop ? crop[3] : frame.h;
    c.width = w * scale; c.height = hh * scale;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(Sprites.atlas, (silhouette ? frame.fx : frame.x) + sx, (silhouette ? frame.fy : frame.y) + sy, w, hh, 0, 0, w * scale, hh * scale);
    if (silhouette) { g.globalCompositeOperation = 'source-in'; g.fillStyle = '#2e2b3a'; g.fillRect(0, 0, c.width, c.height); }
    return c;
  }
  function icon(name, scale) { return paint(frameOf('icon_' + name), scale || 2); }
  /** Иконка достижения: босс — уменьшенный спрайт, иначе пиксельная иконка. */
  function achIcon(name) {
    if (name.indexOf('boss_') === 0) {
      const b = window.BOSSES.find((x) => x.id === name.slice(5));
      const f = frameOf(b.sprite, 'walk'), c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      const k = 32 / Math.max(f.w, f.h);
      g.drawImage(Sprites.atlas, f.x, f.y, f.w, f.h, (32 - f.w * k) / 2, (32 - f.h * k) / 2, f.w * k, f.h * k);
      return c;
    }
    return icon(name, 2);
  }
  function ashAmount(n, cls) { return h('span', 'ash-amount' + (cls ? ' ' + cls : ''), [icon('ash', 1), document.createTextNode(String(n))]); }

  // =====================================================================
  // Фон меню: низкое разрешение, целый множитель (как в игре)
  // =====================================================================
  class MenuBackdrop {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.buf = document.createElement('canvas');
      this.bctx = this.buf.getContext('2d', { alpha: false });
      this.fog = [this.makeFog(1), this.makeFog(2)];
      this.embers = [];
      for (let i = 0; i < 48; i++) this.embers.push({ x: Math.random(), y: Math.random(), v: 0.5 + Math.random(), p: Math.random() * TAU, c: Math.random() < 0.7 ? 0 : 1 });
      this.t = 0; this.hero = null; this.stage = null; this.showHero = true; this.dim = 0;
    }
    /** Тайлящийся «туман» из value-noise, предрасчитан один раз. */
    makeFog(seed) {
      const W = 128, H = 64, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = Sprites.fbm(x / 32, y / 32, seed * 97, 3, 4);
        const a = Math.max(0, v - 0.45) * 2.2;
        const th = Sprites.bayer(x, y);
        const i = (y * W + x) * 4;
        d[i] = 90; d[i + 1] = 70; d[i + 2] = 130; d[i + 3] = a > th * 0.9 ? 60 + a * 60 : 0;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    resize(w, h, dpr) {
      const dw = Math.round(w * dpr), dh = Math.round(h * dpr);
      this.canvas.width = dw; this.canvas.height = dh;
      this.k = Math.max(1, Math.round(Math.min(dw, dh) / 210));
      this.bw = Math.ceil(dw / this.k); this.bh = Math.ceil(dh / this.k);
      this.buf.width = this.bw; this.buf.height = this.bh;
      this.bctx.imageSmoothingEnabled = false;
      this.dpr = dpr;
    }
    /** stageRect — прямоугольник (CSS px) для героя на главной; null — героя не рисуем. */
    setStage(rect) { this.stage = rect; }

    draw(dt) {
      this.t += dt;
      const g = this.bctx, W = this.bw, H = this.bh, t = this.t, low = Settings.quality === 'low';
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      g.fillStyle = '#0d0a14'; g.fillRect(0, 0, W, H);
      // небо: ступенчатые полосы вместо гладкого градиента — пиксельно
      const bands = ['#120c1c', '#160e24', '#1b102c', '#200f30'];
      for (let i = 0; i < bands.length; i++) { g.fillStyle = bands[i]; g.fillRect(0, Math.round(H * (0.25 + i * 0.13)), W, H); }
      // далёкие курганы-силуэты
      g.fillStyle = '#0d0a14';
      for (let x = 0; x < W; x++) {
        const y = H * 0.72 + Math.sin(x * 0.045) * 8 + Math.sin(x * 0.13 + 1) * 3;
        g.fillRect(x, Math.round(y), 1, H);
      }
      // туман: два слоя с разной скоростью
      if (!low) {
        for (let l = 0; l < 2; l++) {
          const f = this.fog[l], sp = l ? 4 : 2.2, y0 = Math.round(H * (l ? 0.62 : 0.5));
          const off = Math.round((t * sp) % f.width);
          g.globalAlpha = l ? 0.5 : 0.35;
          for (let x = -off; x < W; x += f.width) g.drawImage(f, x, y0);
        }
        g.globalAlpha = 1;
      }

      const s = this.stage, k = this.k, dpr = this.dpr;
      if (s && this.showHero && this.hero) {
        const cx = Math.round((s.x + s.w / 2) * dpr / k), base = Math.round((s.y + s.h * 0.86) * dpr / k);
        const scale = Math.max(1, Math.min(3, Math.floor(s.h * dpr / k / 34)));
        this.drawStage(g, cx, base, scale, t);
      }
      // пепел и искры
      const n = low ? 16 : this.embers.length;
      for (let i = 0; i < n; i++) {
        const e = this.embers[i];
        e.y -= e.v * dt * 0.035; e.x += Math.sin(t * 0.7 + e.p) * dt * 0.006;
        if (e.y < -0.02) { e.y = 1.02; e.x = Math.random(); }
        const fl = 0.5 + 0.5 * Math.sin(t * 3 + e.p * 7);
        g.globalAlpha = 0.35 + fl * 0.5;
        g.fillStyle = e.c ? '#9a58c4' : fl > 0.7 ? '#ffae3a' : '#ec6a14';
        g.fillRect(Math.round(e.x * W), Math.round(e.y * H), 1, 1);
      }
      g.globalAlpha = 1;
      if (this.dim > 0) { g.globalAlpha = this.dim; g.fillStyle = '#0d0a14'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }

      const c = this.ctx;
      c.imageSmoothingEnabled = false;
      c.drawImage(this.buf, 0, 0, W * k, H * k);
    }

    /** Постамент с рунами, свечение, герой с idle-анимацией и мерцанием оружия. */
    drawStage(g, cx, base, sc, t) {
      const hero = this.hero, spr = Sprites.get(hero.sprite), fr = spr.anims.idle;
      const f = fr[((t * 2) | 0) % fr.length];
      const low = Settings.quality === 'low';
      // свечение за героем
      g.globalCompositeOperation = 'lighter';
      const glowR = 44 * sc;
      g.globalAlpha = 0.16 + 0.03 * Math.sin(t * 1.6);
      g.drawImage(Sprites.glow.purple, cx - glowR, base - 20 * sc - glowR, glowR * 2, glowR * 2);
      g.globalAlpha = 0.12;
      g.drawImage(Sprites.glow.red, cx - glowR * 0.7, base - glowR * 0.4, glowR * 1.4, glowR * 0.8);
      g.globalCompositeOperation = 'source-over';
      // постамент: плоский эллипс камня
      const rx = 22 * sc, ry = 6 * sc;
      for (let y = -ry; y <= ry + 3 * sc; y++) {
        const yy = Math.min(y, ry), w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (yy * yy) / (ry * ry))));
        g.fillStyle = y > ry ? '#1b102c' : y > 0 ? '#2e2b3a' : '#4a4658';
        g.fillRect(cx - w, base + y, w * 2, 1);
      }
      // руны по кругу, медленно вращаются
      const rn = 12;
      for (let i = 0; i < rn; i++) {
        const a = i / rn * TAU + t * 0.25, x = cx + Math.cos(a) * (rx - 4 * sc), y = base + Math.sin(a) * (ry - 1.5 * sc);
        const on = (Math.sin(t * 2 + i) + 1) / 2;
        g.fillStyle = on > 0.6 ? '#d095f0' : '#6a3290';
        g.fillRect(Math.round(x), Math.round(y), sc, sc);
        if (on > 0.6) g.fillRect(Math.round(x) - sc, Math.round(y), sc, sc);
      }
      // тень и герой
      g.globalAlpha = 0.5; g.fillStyle = '#0d0a14';
      g.fillRect(cx - 7 * sc, base - sc, 14 * sc, 2 * sc);
      g.globalAlpha = 1;
      const bob = Math.round(Math.sin(t * 2) * 0.5 * sc);
      g.drawImage(Sprites.atlas, f.x, f.y, f.w, f.h, cx - Math.round(f.ax * sc), base - Math.round(f.ay * sc) + bob, f.w * sc, f.h * sc);
      // оружие светится цветом героя
      if (!low) {
        g.globalCompositeOperation = 'lighter';
        const gl = { knight: 'ice', witch: 'ice', huntress: 'warm', gravedigger: 'fire' }[hero.id] || 'gold';
        const r = (6 + Math.sin(t * 3) * 1.5) * sc;
        g.globalAlpha = 0.55;
        const wx = cx + 7 * sc, wy = base - (hero.id === 'witch' ? 26 : 12) * sc + bob;
        g.drawImage(Sprites.glow[gl], wx - r, wy - r, r * 2, r * 2);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
      }
    }
  }

  // =====================================================================
  // Menu
  // =====================================================================
  const PAGES = [
    ['main', 'Главная', 'home'],
    ['heroes', 'Герои', 'helmet'],
    ['upgrades', 'Улучшения', 'up'],
    ['arsenal', 'Арсенал', 'swords'],
    ['collection', 'Коллекция', 'tome'],
  ];

  class Menu {
    constructor(game) {
      this.game = game;
      this.root = document.getElementById('menu');
      this.page = 'main';
      this.overlay = null;
      this.collectionTab = 'enemies';
      this.build();
      this.backdrop = new MenuBackdrop(this.bg);
      this.visible = false;
      this.last = 0;
      this.loop = this.loop.bind(this);
      this.onResize = () => { this.resize(); };
      window.addEventListener('resize', this.onResize);
    }

    // ---------- Каркас ----------
    build() {
      const r = this.root;
      r.textContent = '';
      this.bg = h('canvas', 'menu-bg');
      r.appendChild(this.bg);

      // верхняя панель
      this.avatar = h('span', 'avatar');
      this.nameEl = h('span', 'p-name');
      this.accLevel = h('span', 'acc-level');
      this.accFill = h('span');
      const profile = h('button', 'profile', [this.avatar, h('span', 'p-info', [this.nameEl, h('span', 'acc', [this.accLevel, h('span', 'acc-bar', [this.accFill])])])]);
      profile.setAttribute('aria-label', 'Профиль и настройки');
      profile.addEventListener('click', () => this.openOverlay('settings'));
      this.walletEl = h('span', 'wallet');
      const settingsBtn = h('button', 'icon-btn', [icon('gear', 2)]);
      settingsBtn.setAttribute('aria-label', 'Настройки');
      settingsBtn.addEventListener('click', () => this.openOverlay('settings'));
      r.appendChild(h('header', 'topbar', [profile, this.walletEl, settingsBtn]));

      // разделы
      this.pages = {};
      const pagesWrap = h('div', 'pages');
      for (const [id] of PAGES) { const p = h('section', 'page' + (id === 'main' ? '' : ' scroll')); p.hidden = true; this.pages[id] = p; pagesWrap.appendChild(p); }
      r.appendChild(pagesWrap);

      // нижняя панель
      this.navBtns = {};
      const nav = h('nav', 'bottomnav');
      for (const [id, label, ic] of PAGES) {
        const b = h('button', 'nav-btn', [icon(ic, 2), h('span', 'nav-label', label)]);
        b.addEventListener('click', () => { Sfx.play('click'); this.showPage(id); });
        this.navBtns[id] = b; nav.appendChild(b);
      }
      r.appendChild(nav);

      // окна поверх
      this.overlays = {};
      for (const id of ['prep', 'settings', 'daily', 'achievements', 'confirm']) {
        const o = h('div', 'overlay' + (id === 'confirm' ? ' small' : ''));
        o.hidden = true;
        o.addEventListener('click', (e) => { if (e.target === o) this.closeOverlay(); });
        this.overlays[id] = o; r.appendChild(o);
      }
      this.toastEl = h('div', 'toast'); this.toastEl.hidden = true;
      r.appendChild(this.toastEl);
    }

    open(page, reward) {
      this.root.hidden = false;
      this.visible = true;
      this.closeOverlay(true);
      this.showPage(page || 'main');
      this.resize();
      if (reward) this.toast('+' + reward.total + ' пепла за забег' + (reward.completed.length ? ' · заданий: ' + reward.completed.length : ''));
      this.last = performance.now();
      requestAnimationFrame(this.loop);
    }
    close() { this.root.hidden = true; this.visible = false; this.closeOverlay(true); }

    loop(now) {
      if (!this.visible) return;
      requestAnimationFrame(this.loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (Settings.reduceMotion) { if (this.staticDrawn) return; this.staticDrawn = true; this.backdrop.draw(0); return; }
      this.backdrop.draw(dt);
    }
    resize() {
      if (!this.visible) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.backdrop.resize(window.innerWidth, window.innerHeight, dpr);
      this.updateStage();
    }
    updateStage() {
      const st = this.page === 'main' && !this.overlay ? this.stageEl : null;
      if (st && st.getBoundingClientRect) {
        const b = st.getBoundingClientRect();
        this.backdrop.setStage({ x: b.left, y: b.top, w: b.width, h: b.height });
      } else this.backdrop.setStage(null);
      this.backdrop.dim = this.page === 'main' ? 0 : 0.35;
      this.staticDrawn = false;
    }

    toast(text) {
      const t = this.toastEl;
      t.textContent = text; t.hidden = false;
      t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    }
    /** Недостаток валюты: сообщение и встряска кнопки. */
    poor(btn, cost) {
      Sfx.play('hurt');
      this.toast('Не хватает ' + (cost - Meta.ash) + ' пепла');
      btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    }

    // ---------- Верхняя панель ----------
    refreshTop() {
      const hero = this.selectedHero();
      this.avatar.textContent = '';
      this.avatar.appendChild(paint(frameOf(hero.sprite, 'idle'), 2, false, [8, 2, 16, 16]));
      this.avatar.style.setProperty('--hero', hero.color);
      this.nameEl.textContent = Meta.profile.name;
      const acc = Meta.account;
      this.accLevel.textContent = 'Ур. ' + acc.level;
      this.accFill.style.width = Math.round(acc.xp / window.ACCOUNT.xpFor(acc.level) * 100) + '%';
      this.walletEl.textContent = '';
      this.walletEl.appendChild(ashAmount(Meta.ash));
      this.backdrop && (this.backdrop.hero = hero);
    }
    selectedHero() {
      const h0 = window.HEROES.find((x) => x.id === Meta.sel.hero);
      return h0 && Meta.isUnlocked(h0) ? h0 : window.HEROES[0];
    }

    // ---------- Разделы ----------
    showPage(id) {
      this.page = id;
      for (const k in this.pages) this.pages[k].hidden = k !== id;
      for (const k in this.navBtns) {
        this.navBtns[k].classList.toggle('active', k === id);
        this.navBtns[k].setAttribute('aria-current', k === id ? 'page' : 'false');
      }
      this.refreshTop();
      this['build_' + id](this.pages[id]);
      this.pages[id].scrollTop = 0;
      this.updateStage();
    }
    rebuild() {
      const p = this.pages[this.page], y = p.scrollTop;
      this.refreshTop();
      this['build_' + this.page](p);
      p.scrollTop = y;
      this.updateStage();
    }

    build_main(p) {
      p.textContent = '';
      const hero = this.selectedHero();
      const logo = h('div', 'logo', [h('span', 'logo-top', 'NIGHTFALL'), h('span', 'logo-bottom', 'SURVIVORS'), h('span', 'logo-sub', 'Продержись до рассвета')]);
      this.stageEl = h('button', 'stage');
      this.stageEl.setAttribute('aria-label', 'Герой: ' + hero.name + '. Открыть список героев');
      this.stageEl.addEventListener('click', () => this.showPage('heroes'));
      const heroLine = h('div', 'stage-name', [h('span', 'sn-name', hero.name), h('span', 'sn-title', hero.title + ' · ур. ' + Meta.heroLevel(hero.id))]);
      const play = h('button', 'btn-play', 'ИГРАТЬ');
      play.addEventListener('click', () => { Sfx.play('click'); this.openOverlay('prep'); });
      const daily = this.sideButton('Задания дня', 'scroll', Meta.claimable(), () => this.openOverlay('daily'));
      const ach = this.sideButton('Достижения', 'trophy', Meta.achClaimable(), () => this.openOverlay('achievements'));
      const best = this.game.bestTime;
      p.appendChild(logo);
      p.appendChild(this.stageEl);
      p.appendChild(heroLine);
      p.appendChild(play);
      p.appendChild(h('div', 'side-row', [daily, ach]));
      if (best > 0) p.appendChild(h('p', 'best-line', 'Рекорд: ' + formatTime(best)));
    }
    sideButton(label, ic, badge, onClick) {
      const b = h('button', 'btn-side', [icon(ic, 2), h('span', '', label)]);
      if (badge) b.appendChild(h('span', 'badge', String(badge)));
      b.addEventListener('click', () => { Sfx.play('click'); onClick(); });
      return b;
    }
    pageHead(title, sub) { return h('div', 'page-head', [h('h2', '', title), sub ? h('p', 'page-sub', sub) : null]); }

    /** Кнопка покупки: цена или действие; недостаток пепла — встряска и сообщение. */
    buyBtn(cost, onBuy, label) {
      const b = h('button', 'buy' + (Meta.ash < cost ? ' poor' : ''), [label ? h('span', '', label) : null, ashAmount(cost)]);
      b.addEventListener('click', () => {
        if (Meta.ash < cost) { this.poor(b, cost); return; }
        if (onBuy()) { Sfx.play('chest'); this.rebuild(); }
      });
      return b;
    }
    stagger(list) { list.forEach((el, i) => el.style.setProperty('--i', String(i))); }

    // ---- Герои ----
    build_heroes(p) {
      p.textContent = '';
      p.appendChild(this.pageHead('Персонажи', 'Выбери героя. Уровни героя усиливают его навсегда.'));
      const list = h('div', 'cards');
      const sel = this.selectedHero();
      for (const hero of window.HEROES) {
        const open = Meta.isUnlocked(hero), lvl = Meta.heroLevel(hero.id), b = Meta.bonuses(hero.id), s = hero.stats;
        const card = h('article', 'card hero-card' + (hero === sel ? ' selected' : '') + (open ? '' : ' locked'));
        card.style.setProperty('--hero', hero.color);
        const portrait = h('div', 'portrait', [paint(frameOf(hero.sprite, 'idle'), 2, !open)]);
        if (!open) portrait.appendChild(h('span', 'lock-badge', [icon('lock', 1)]));
        const w = window.WEAPONS.find((x) => x.id === hero.weapon);
        const stat = (label, val) => h('span', 'stat-chip', [h('span', 'sc-l', label), h('span', 'sc-v', String(val))]);
        const stats = h('div', 'stat-row', [
          stat('Здоровье', Math.round(s.hp * b.hpMul + b.hp)),
          stat('Скорость', Math.round(s.speed * (1 + b.speed))),
          stat('Урон', '×' + (s.might + b.might).toFixed(2)),
          stat('Броня', s.armor + b.armor),
        ]);
        const body = h('div', 'card-body', [
          h('div', 'card-title', [h('span', 'ct-name', hero.name), h('span', 'tag', open ? 'Ур. ' + lvl : 'Закрыт')]),
          h('div', 'card-sub', hero.title),
          h('p', 'card-text', hero.lore),
          stats,
          h('div', 'perk', [h('span', 'perk-l', 'Особенность'), h('span', '', hero.perk)]),
          h('div', 'weapon-line', [icon(w.icon, 1), h('span', '', 'Оружие: ' + w.name)]),
        ]);
        const actions = h('div', 'card-actions');
        if (!open) {
          const u = hero.unlock;
          if (u.cost) actions.appendChild(this.buyBtn(u.cost, () => { if (!Meta.buyUnlock(hero)) return false; Meta.select('hero', hero.id); return true; }, 'Разблокировать'));
          else actions.appendChild(h('div', 'condition', [icon('lock', 1), h('span', '', u.text)]));
        } else {
          if (hero === sel) actions.appendChild(h('span', 'chosen', [icon('check', 1), h('span', '', 'Выбран')]));
          else {
            const pick = h('button', 'btn-sec', 'Выбрать');
            pick.addEventListener('click', () => { Meta.select('hero', hero.id); Sfx.play('click'); this.rebuild(); });
            actions.appendChild(pick);
          }
          const cost = Meta.heroCost(hero.id);
          if (cost) actions.appendChild(this.buyBtn(cost, () => Meta.upgradeHero(hero.id), 'Ур. ' + (lvl + 1)));
          else actions.appendChild(h('span', 'maxed', 'Макс. уровень'));
          body.appendChild(h('div', 'next-line', cost ? 'Ур. ' + (lvl + 1) + ': ' + Meta.heroText(hero.id, lvl + 1) : Meta.heroText(hero.id)));
        }
        card.appendChild(portrait); card.appendChild(body); card.appendChild(actions);
        list.appendChild(card);
      }
      this.stagger([...list.children]);
      p.appendChild(list);
    }

    // ---- Улучшения ----
    build_upgrades(p) {
      p.textContent = '';
      p.appendChild(this.pageHead('Улучшения', 'Действуют на всех героев, в каждом забеге.'));
      const list = h('div', 'cards');
      for (const it of window.ITEMS) {
        const l = Meta.itemLevel(it.id), cost = Meta.itemCost(it);
        const pips = h('div', 'pips');
        for (let i = 0; i < it.max; i++) pips.appendChild(h('span', i < l ? 'on' : ''));
        const change = h('div', 'change', [
          h('span', 'ch-now', l ? it.text(l) : 'нет'),
          cost ? h('span', 'ch-arrow', '→') : null,
          cost ? h('span', 'ch-next', it.text(l + 1)) : null,
        ]);
        const card = h('article', 'card item-card' + (l >= it.max ? ' maxed-card' : ''), [
          h('div', 'icon-box', [icon(it.icon, 3)]),
          h('div', 'card-body', [h('div', 'card-title', [h('span', 'ct-name', it.name), h('span', 'tag', l + '/' + it.max)]), change, pips]),
          h('div', 'card-actions', [cost ? this.buyBtn(cost, () => Meta.upgradeItem(it)) : h('span', 'maxed', 'Максимум')]),
        ]);
        list.appendChild(card);
      }
      this.stagger([...list.children]);
      p.appendChild(list);
    }

    // ---- Арсенал ----
    build_arsenal(p) {
      p.textContent = '';
      p.appendChild(this.pageHead('Арсенал', 'Оружие появляется в забеге при повышении уровня. Мастерство усиливает его навсегда.'));
      const M = window.WEAPON_MASTERY, list = h('div', 'cards');
      for (const w of window.WEAPONS) {
        const found = Meta.weaponFound(w.id), m = Meta.mastery(w.id), mul = Meta.weaponDamageMul(w.id);
        const a = w.cls.info(1), z = w.cls.info(7);
        const state = !found ? 'Заблокировано' : m ? 'Улучшено ' + m + '/' + M.max : 'Открыто';
        const stat = (label, v1, v7) => h('div', 'wstat', [h('span', 'ws-l', label), h('span', 'ws-v', v1), h('span', 'ws-max', v7)]);
        const grid = h('div', 'wstats', [
          h('div', 'wstat head', [h('span', 'ws-l', ''), h('span', 'ws-v', 'ур. 1'), h('span', 'ws-max', 'ур. 7')]),
          stat('Урон', String(Math.round(a.dmg * mul)), String(Math.round(z.dmg * mul))),
          stat('Атак/с', (1 / a.cd).toFixed(1), (1 / z.cd).toFixed(1)),
          stat('Дальность', String(a.range), String(z.range)),
        ]);
        const pips = h('div', 'pips gold');
        for (let i = 0; i < M.max; i++) pips.appendChild(h('span', i < m ? 'on' : ''));
        const body = h('div', 'card-body', [
          h('div', 'card-title', [h('span', 'ct-name', found ? w.name : '???'), h('span', 'tag' + (found ? m ? ' gold' : '' : ' dim'), state)]),
          h('p', 'card-text', found ? w.desc : 'Найди в сундуке босса.'),
          w.signature ? h('div', 'card-sub', 'Базовая атака Ольгерда, другим героям не выпадает') : null,
          found ? grid : null,
          found ? h('div', 'card-sub', 'Ур. 7: ' + z.extra) : null,
          found ? pips : null,
        ]);
        const actions = h('div', 'card-actions');
        if (!found) actions.appendChild(h('div', 'condition', [icon('lock', 1), h('span', '', 'Сундук босса')]));
        else {
          const c = Meta.masteryCost(w.id);
          actions.appendChild(c ? this.buyBtn(c, () => Meta.upgradeMastery(w.id), '+' + Math.round(M.dmgPerLevel * 100) + '% урона') : h('span', 'maxed', 'Мастер'));
        }
        const ic = found ? icon(w.icon, 3) : paint(frameOf('icon_' + w.icon), 3, true);
        list.appendChild(h('article', 'card weapon-card' + (found ? '' : ' locked'), [h('div', 'icon-box', [ic]), body, actions]));
      }
      this.stagger([...list.children]);
      p.appendChild(list);
    }

    // ---- Коллекция ----
    build_collection(p) {
      p.textContent = '';
      p.appendChild(this.pageHead('Коллекция', 'Записи открываются, когда побеждаешь врага.'));
      const tabs = h('div', 'tabs');
      const tabDefs = [['enemies', 'Враги'], ['bosses', 'Боссы'], ['relics', 'Реликвии']];
      for (const [id, label] of tabDefs) {
        const b = h('button', 'tab' + (this.collectionTab === id ? ' active' : ''), label);
        b.setAttribute('aria-pressed', String(this.collectionTab === id));
        b.addEventListener('click', () => { this.collectionTab = id; Sfx.play('click'); this.rebuild(); });
        tabs.appendChild(b);
      }
      p.appendChild(tabs);
      const list = h('div', 'cards');
      let total = 0, seen = 0;
      if (this.collectionTab === 'enemies' || this.collectionTab === 'bosses') {
        const entries = this.collectionTab === 'enemies'
          ? Object.keys(window.ENEMIES).map((id) => ({ key: window.ENEMIES[id].sprite, sprite: window.ENEMIES[id].sprite, d: window.ENEMIES[id], elite: window.ENEMIES[id].elite }))
          : window.BOSSES.map((b) => ({ key: b.id, sprite: b.sprite, d: b, boss: true }));
        for (const e of entries) {
          total++;
          const n = Meta.seen(e.key), known = n > 0;
          if (known) seen++;
          const f = frameOf(e.sprite, Sprites.get(e.sprite).anims.walk ? 'walk' : undefined);
          const sc = e.boss ? 1 : 2;
          const card = h('article', 'card beast-card' + (known ? '' : ' locked'), [
            h('div', 'beast-art', [paint(f, sc, !known)]),
            h('div', 'card-body', [
              h('div', 'card-title', [h('span', 'ct-name', known ? e.d.name : '???'), known ? h('span', 'tag', (e.boss ? 'Побеждён: ' : 'Убито: ') + n) : null]),
              h('p', 'card-text', known ? e.d.lore : e.boss ? 'Появляется на ' + Math.round(e.d.time / 60) + '-й минуте.' : 'Ещё не встречался.'),
              known && e.elite ? h('div', 'card-sub', 'Бывает элитным: крупнее, с золотой аурой.') : null,
            ]),
          ]);
          list.appendChild(card);
        }
      } else {
        for (const it of window.ITEMS) {
          total++;
          const l = Meta.itemLevel(it.id), known = l > 0;
          if (known) seen++;
          list.appendChild(h('article', 'card item-card' + (known ? '' : ' locked'), [
            h('div', 'icon-box', [known ? icon(it.icon, 3) : paint(frameOf('icon_' + it.icon), 3, true)]),
            h('div', 'card-body', [h('div', 'card-title', [h('span', 'ct-name', known ? it.name : '???'), known ? h('span', 'tag', 'Ур. ' + l) : null]),
              h('p', 'card-text', known ? it.text(l) : 'Купи в разделе «Улучшения».')]),
          ]));
        }
      }
      p.appendChild(h('p', 'page-sub counter', 'Открыто: ' + seen + ' из ' + total));
      this.stagger([...list.children]);
      p.appendChild(list);
    }

    // ---------- Окна поверх ----------
    openOverlay(id) {
      Sfx.play('click');
      if (this.overlay && this.overlay !== id) this.overlays[this.overlay].hidden = true;
      this.overlay = id;
      const o = this.overlays[id];
      o.textContent = '';
      const panel = h('div', 'panel scroll');
      this['ov_' + id](panel);
      o.appendChild(panel);
      o.hidden = false;
      this.updateStage();
    }
    closeOverlay(silent) {
      if (!this.overlay) return;
      this.overlays[this.overlay].hidden = true;
      this.overlay = null;
      if (!silent) { Sfx.play('click'); this.rebuild(); }
    }
    panelHead(panel, title) {
      const close = h('button', 'icon-btn close', '✕');
      close.setAttribute('aria-label', 'Закрыть');
      close.addEventListener('click', () => this.closeOverlay());
      panel.appendChild(h('div', 'panel-head', [h('h2', '', title), close]));
    }
    reopen() { const id = this.overlay, y = this.overlays[id].firstChild.scrollTop; this.openOverlay(id); this.overlays[id].firstChild.scrollTop = y; this.refreshTop(); }

    // ---- Подготовка к забегу ----
    ov_prep(panel) {
      this.panelHead(panel, 'Подготовка');
      const sel = Meta.sel;
      // герой
      panel.appendChild(h('h3', 'sec', 'Герой'));
      const heroes = h('div', 'hero-strip');
      const cur = this.selectedHero();
      for (const hero of window.HEROES) {
        const open = Meta.isUnlocked(hero);
        const b = h('button', 'hero-chip' + (hero === cur ? ' selected' : ''), [paint(frameOf(hero.sprite, 'idle'), 2, !open), h('span', '', open ? hero.name : 'Закрыт')]);
        b.style.setProperty('--hero', hero.color);
        b.disabled = !open;
        b.setAttribute('aria-pressed', String(hero === cur));
        b.addEventListener('click', () => { Meta.select('hero', hero.id); this.reopen(); });
        heroes.appendChild(b);
      }
      panel.appendChild(heroes);
      // карта
      panel.appendChild(h('h3', 'sec', 'Карта'));
      const maps = h('div', 'opt-list');
      for (const m of window.MAPS) {
        const open = Meta.isUnlocked(m), on = sel.map === m.id || (!Meta.isUnlocked(window.MAPS.find((x) => x.id === sel.map) || m) && m === window.MAPS[0]);
        const b = h('button', 'opt' + (on ? ' selected' : ''), [
          h('div', 'icon-box', [open ? icon(m.icon, 3) : paint(frameOf('icon_' + m.icon), 3, true)]),
          h('div', 'card-body', [h('div', 'ct-name', m.name), h('p', 'card-text', open ? m.desc : m.unlock.text)]),
          open ? null : h('span', 'lock-badge', [icon('lock', 1)]),
        ]);
        b.disabled = !open;
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => { Meta.select('map', m.id); this.reopen(); });
        maps.appendChild(b);
      }
      panel.appendChild(maps);
      // сложность
      panel.appendChild(h('h3', 'sec', 'Сложность'));
      const seg = h('div', 'segmented');
      let curDif = window.DIFFICULTIES.find((d) => d.id === sel.difficulty);
      if (!curDif || !Meta.isUnlocked(curDif)) curDif = window.DIFFICULTIES[0];
      for (const d of window.DIFFICULTIES) {
        const open = Meta.isUnlocked(d);
        const b = h('button', 'seg' + (d === curDif ? ' active' : ''), [open ? null : icon('lock', 1), h('span', '', d.name)]);
        b.disabled = !open;
        b.setAttribute('aria-pressed', String(d === curDif));
        b.addEventListener('click', () => { Meta.select('difficulty', d.id); this.reopen(); });
        seg.appendChild(b);
      }
      panel.appendChild(seg);
      panel.appendChild(h('p', 'hint-line', curDif.desc + (window.DIFFICULTIES.some((d) => !Meta.isUnlocked(d)) ? ' Кошмар: ' + window.DIFFICULTIES[2].unlock.text.toLowerCase() + '.' : '')));
      // модификаторы
      panel.appendChild(h('h3', 'sec', 'Модификаторы'));
      const mods = h('div', 'opt-list');
      for (const m of window.MODIFIERS) {
        const on = sel.mods.indexOf(m.id) >= 0;
        const b = h('button', 'opt toggle' + (on ? ' selected' : ''), [
          h('div', 'icon-box', [icon(m.icon, 2)]),
          h('div', 'card-body', [h('div', 'ct-name', m.name), h('p', 'card-text', m.desc)]),
          h('span', 'switch' + (on ? ' on' : ''), [h('span')]),
        ]);
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => { Meta.toggleMod(m.id); Sfx.play('click'); this.reopen(); });
        mods.appendChild(b);
      }
      panel.appendChild(mods);
      const bonus = Math.round(Meta.runAshBonus({ map: Meta.isUnlocked(window.MAPS.find((x) => x.id === sel.map) || window.MAPS[0]) ? sel.map : 'wastes', difficulty: curDif.id, mods: sel.mods }) * 100);
      const start = h('button', 'btn-play wide', 'НАЧАТЬ ЗАБЕГ');
      start.addEventListener('click', () => { Sfx.play('levelup'); this.game.start(); });
      panel.appendChild(h('div', 'panel-foot', [h('p', 'bonus-line', [icon('ash', 1), h('span', '', bonus ? 'Бонус пепла: +' + bonus + '%' : 'Без бонуса пепла')]), start]));
    }

    // ---- Настройки ----
    ov_settings(panel) {
      this.panelHead(panel, 'Настройки');
      const row = (ic, label, control, note) => h('div', 'set-row', [h('div', 'icon-box small', [icon(ic, 2)]), h('div', 'set-label', [h('span', '', label), note ? h('span', 'set-note', note) : null]), control]);
      const toggle = (on, onChange, disabled) => {
        const b = h('button', 'switch' + (on ? ' on' : ''), [h('span')]);
        b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(on));
        b.disabled = !!disabled;
        b.addEventListener('click', () => { onChange(!on); this.reopen(); });
        return b;
      };
      panel.appendChild(h('h3', 'sec', 'Звук'));
      panel.appendChild(row('music', 'Музыка', toggle(Music.enabled, (v) => Music.setEnabled(v))));
      panel.appendChild(row('sound', 'Звуковые эффекты', toggle(Sfx.enabled, (v) => { Sfx.setEnabled(v); Sfx.play('click'); })));
      panel.appendChild(row('vibe', 'Вибрация', toggle(Settings.vibration && Settings.canVibrate, (v) => { Settings.set('vibration', v); Settings.vibrate(30); }, !Settings.canVibrate),
        Settings.canVibrate ? 'При ранении и новом уровне' : 'Не поддерживается этим устройством'));
      panel.appendChild(h('h3', 'sec', 'Графика'));
      const q = h('div', 'segmented small');
      for (const [id, label] of [['high', 'Высокое'], ['low', 'Низкое']]) {
        const b = h('button', 'seg' + (Settings.quality === id ? ' active' : ''), label);
        b.setAttribute('aria-pressed', String(Settings.quality === id));
        b.addEventListener('click', () => { Settings.set('quality', id); this.reopen(); });
        q.appendChild(b);
      }
      panel.appendChild(row('eye', 'Качество', q, 'Низкое: меньше частиц и свечения'));
      panel.appendChild(row('motion', 'Меньше анимаций', toggle(Settings.reduceMotion, (v) => Settings.set('reduceMotion', v)), 'Без движения фона и переходов'));
      panel.appendChild(h('h3', 'sec', 'Профиль'));
      const input = h('input', 'name-input');
      input.type = 'text'; input.maxLength = 16; input.value = Meta.profile.name;
      input.setAttribute('aria-label', 'Имя игрока');
      input.addEventListener('change', () => { Meta.setName(input.value); this.refreshTop(); });
      panel.appendChild(row('helmet', 'Имя игрока', input));
      panel.appendChild(row('tome', 'Язык', h('span', 'set-value', 'Русский'), 'Другие языки появятся позже'));
      panel.appendChild(h('h3', 'sec', 'Прочее'));
      const gal = h('button', 'btn-sec', 'Галерея спрайтов');
      gal.addEventListener('click', () => { this.closeOverlay(true); this.game.ui.showGallery(); });
      const reset = h('button', 'btn-danger', 'Сбросить прогресс');
      reset.addEventListener('click', () => this.openOverlay('confirm'));
      panel.appendChild(h('div', 'set-buttons', [gal, reset]));
      const back = h('button', 'btn-sec wide', 'Назад');
      back.addEventListener('click', () => this.closeOverlay());
      panel.appendChild(back);
    }
    ov_confirm(panel) {
      this.panelHead(panel, 'Сбросить прогресс?');
      panel.appendChild(h('p', 'card-text', 'Пепел, уровни героев, улучшения, достижения и бестиарий будут удалены. Это нельзя отменить.'));
      const yes = h('button', 'btn-danger wide', 'Да, сбросить');
      yes.addEventListener('click', () => { Meta.resetAll(); this.closeOverlay(true); this.toast('Прогресс сброшен'); this.showPage('main'); });
      const no = h('button', 'btn-sec wide', 'Отмена');
      no.addEventListener('click', () => this.openOverlay('settings'));
      panel.appendChild(h('div', 'set-buttons col', [yes, no]));
    }

    // ---- Задания дня ----
    ov_daily(panel) {
      this.panelHead(panel, 'Задания дня');
      const d = Meta.daily(), sec = Meta.secondsToReset(), hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60;
      panel.appendChild(h('p', 'hint-line', 'Новые задания через ' + (hh ? hh + ' ч ' : '') + mm + ' мин. Прогресс копится во всех забегах за день.'));
      const list = h('div', 'cards');
      d.quests.forEach((q, i) => {
        const info = Meta.questInfo(q), fmt = (v) => (info.isTime ? formatTime(v) : String(v));
        list.appendChild(this.questCard(icon('scroll', 3), info.text, fmt(info.progress) + ' / ' + fmt(info.target), info.progress / info.target, info.reward, info.done, info.claimed, () => Meta.claim(i)));
      });
      const all = d.quests.every((q) => q.claimed);
      list.appendChild(this.questCard(icon('ash', 3), 'Все задания дня', 'Забери награды всех трёх заданий', d.quests.filter((q) => q.claimed).length / 3, window.DAILY_BONUS, all, d.bonusClaimed, () => Meta.claimBonus()));
      this.stagger([...list.children]);
      panel.appendChild(list);
    }
    questCard(ic, title, progressText, frac, reward, done, claimed, onClaim) {
      const bar = h('div', 'progress', [h('span')]);
      bar.firstChild.style.width = Math.round(Math.min(1, frac) * 100) + '%';
      let act;
      if (claimed) act = h('span', 'chosen', [icon('check', 1), h('span', '', 'Получено')]);
      else if (done) {
        act = h('button', 'buy claim', [h('span', '', 'Забрать'), ashAmount(reward)]);
        act.addEventListener('click', () => { if (onClaim()) { Sfx.play('chest'); this.reopen(); } });
      } else act = h('span', 'reward-preview', [ashAmount(reward)]);
      return h('article', 'card quest-card' + (claimed ? ' maxed-card' : ''), [h('div', 'icon-box', [ic]), h('div', 'card-body', [h('div', 'ct-name', title), h('div', 'card-sub', progressText), bar]), h('div', 'card-actions', [act])]);
    }

    // ---- Достижения и статистика ----
    achText(a) {
      switch (a.stat) {
        case 'kills': return 'Убей ' + a.goal + ' врагов за всё время';
        case 'bestTime': return 'Продержись ' + Math.round(a.goal / 60) + ' мин в одном забеге';
        case 'elites': return 'Убей ' + a.goal + ' элитных врагов';
        case 'bestLevel': return 'Достигни ' + a.goal + ' уровня в забеге';
        case 'runs': return 'Сыграй ' + a.goal + ' забегов дольше минуты';
        case 'heroesUnlocked': return 'Открой всех героев';
        case 'lightning': return 'Найди Цепную молнию в сундуке';
        default: { const b = window.BOSSES.find((x) => 'boss_' + x.id === a.stat); return b ? 'Победи: ' + b.name : ''; }
      }
    }
    ov_achievements(panel) {
      this.panelHead(panel, 'Достижения');
      const st = Meta.stats;
      const cell = (label, v) => h('div', 'stat-cell', [h('span', 'sc-v', String(v)), h('span', 'sc-l', label)]);
      const bossKills = window.BOSSES.reduce((s, b) => s + Meta.seen(b.id), 0);
      panel.appendChild(h('div', 'stat-grid', [
        cell('Забегов', st.runs), cell('Убито врагов', st.kills), cell('Лучшее время', formatTime(st.bestTime)),
        cell('Лучший уровень', st.bestLevel), cell('Боссов повержено', bossKills), cell('Пепла добыто', st.totalAsh),
      ]));
      const list = h('div', 'cards');
      const sorted = window.ACHIEVEMENTS.slice().sort((x, y) => {
        const rank = (a) => (Meta.achClaimed(a) ? 2 : Meta.achProgress(a) >= 1 ? 0 : 1);
        return rank(x) - rank(y);
      });
      for (const a of sorted) {
        const v = Meta.statValue(a.stat), fmt = (n) => (a.time ? formatTime(Math.min(n, a.goal)) : String(Math.min(n, a.goal)));
        list.appendChild(this.questCard(achIcon(a.icon), a.name + ' — ' + this.achText(a), fmt(v) + ' / ' + fmt(a.goal), Meta.achProgress(a), a.reward, Meta.achProgress(a) >= 1, Meta.achClaimed(a), () => Meta.claimAchievement(a)));
      }
      this.stagger([...list.children]);
      panel.appendChild(list);
    }
  }

  window.Menu = Menu;
})();
