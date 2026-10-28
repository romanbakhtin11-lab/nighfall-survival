'use strict';
/*
 * Meta — то, что остаётся между забегами: пепел (валюта), уровни и открытие героев,
 * предметы, мастерство оружия, задания дня, достижения, бестиарий, статистика,
 * уровень аккаунта, профиль и выбор для следующего забега. Хранится в localStorage одним JSON.
 * Логика игры обращается сюда только в начале забега (bonuses) и в конце (finishRun).
 */
(function () {
  const KEY = 'night-swarm-meta';
  const HU = window.HERO_UPGRADE;

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  function load() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { st = null; }
    const legacy = !!st && !st.unlocked;      // сохранение до появления закрытых героев
    st = st || {};
    st.ash = st.ash || 0;
    st.heroes = st.heroes || {};
    st.items = st.items || {};
    st.daily = st.daily || null;
    st.profile = Object.assign({ name: 'Странник' }, st.profile);
    // тем, кто уже играл, все герои остаются открыты
    if (legacy) st.unlocked = { huntress: true, gravedigger: true };
    st.unlocked = st.unlocked || {};          // герои/карты, открытые за пепел (или по старому сохранению)
    st.stats = Object.assign({ kills: 0, elites: 0, runs: 0, bestTime: 0, bestLevel: 0, totalAsh: 0, lightning: 0 }, st.stats);
    st.bestiary = st.bestiary || {};          // тип врага / id босса → убито
    st.achClaimed = st.achClaimed || {};
    st.mastery = st.mastery || {};
    st.account = Object.assign({ level: 1, xp: 0 }, st.account);
    st.sel = Object.assign({ hero: 'knight', map: 'wastes', difficulty: 'normal', mods: [] }, st.sel);
    return st;
  }
  const state = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* приватный режим */ } }

  /** Три задания на сегодня: выбор детерминирован датой, так что не меняется при перезапуске. */
  function rollDaily() {
    const date = today();
    if (state.daily && state.daily.date === date) return state.daily;
    let h = hashStr(date);
    const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909); h >>>= 0; return (h % 10000) / 10000; };
    const pool = window.DAILY_POOL.slice(), quests = [];
    while (quests.length < 3 && pool.length) {
      const def = pool.splice((rnd() * pool.length) | 0, 1)[0];
      const tier = (rnd() * def.targets.length) | 0;
      const q = { id: def.id, tier, progress: 0, claimed: false };
      if (def.hero) { const open = window.HEROES.filter((h) => Meta.isUnlocked(h)); q.hero = open[(rnd() * open.length) | 0].id; }
      quests.push(q);
    }
    state.daily = { date, quests, bonusClaimed: false };
    save();
    return state.daily;
  }

  function questDef(q) { return window.DAILY_POOL.find((d) => d.id === q.id); }

  const Meta = {
    get ash() { return state.ash; },
    heroLevel(id) { return state.heroes[id] || 1; },
    itemLevel(id) { return state.items[id] || 0; },

    heroCost(id) { const l = this.heroLevel(id); return l >= HU.maxLevel ? 0 : HU.cost(l); },
    itemCost(item) { const l = this.itemLevel(item.id); return l >= item.max ? 0 : window.itemCost(item, l); },
    upgradeHero(id) {
      const c = this.heroCost(id);
      if (!c || state.ash < c) return false;
      state.ash -= c; state.heroes[id] = this.heroLevel(id) + 1; save();
      return true;
    },
    upgradeItem(item) {
      const c = this.itemCost(item);
      if (!c || state.ash < c) return false;
      state.ash -= c; state.items[item.id] = this.itemLevel(item.id) + 1; save();
      return true;
    },
    /** Сколько уровней стартового оружия даёт прокачка героя. */
    weaponBonus(id) { const l = this.heroLevel(id); return HU.weaponAt.filter((x) => l >= x).length; },
    heroText(id, level) {
      const l = level || this.heroLevel(id);
      const parts = ['+' + Math.round((l - 1) * HU.hpPerLevel * 100) + '% здоровья', '+' + Math.round((l - 1) * HU.mightPerLevel * 100) + '% урона'];
      const w = HU.weaponAt.filter((x) => l >= x).length;
      if (w) parts.push('оружие +' + w + ' ур.');
      return parts.join(', ');
    },

    /** Все постоянные бонусы для героя: уровень героя + предметы. */
    bonuses(heroId) {
      const l = this.heroLevel(heroId) - 1;
      const b = { hpMul: 1 + l * HU.hpPerLevel, hp: 0, might: l * HU.mightPerLevel, speed: 0, magnet: 0, xp: 0, regen: 0, armor: 0, ash: 0, luck: 0 };
      for (const it of window.ITEMS) { const il = this.itemLevel(it.id); if (il) it.apply(b, il); }
      return b;
    },

    // ---------- Задания дня ----------
    daily() { return rollDaily(); },
    questInfo(q) {
      const def = questDef(q), target = def.targets[q.tier];
      const hero = q.hero ? window.HEROES.find((h) => h.id === q.hero) : null;
      return {
        text: def.text(target, hero ? hero.name : ''),
        target, reward: def.rewards[q.tier],
        progress: Math.min(q.progress, target),
        done: q.progress >= target,
        claimed: q.claimed,
        isTime: def.stat === 'time',
      };
    },
    claimable() {
      const d = rollDaily();
      let n = d.quests.filter((q) => !q.claimed && this.questInfo(q).done).length;
      if (!d.bonusClaimed && d.quests.every((q) => q.claimed)) n++;
      return n;
    },
    claim(i) {
      const d = rollDaily(), q = d.quests[i], info = this.questInfo(q);
      if (!info.done || q.claimed) return 0;
      q.claimed = true; state.ash += info.reward; save();
      return info.reward;
    },
    claimBonus() {
      const d = rollDaily();
      if (d.bonusClaimed || !d.quests.every((q) => q.claimed)) return 0;
      d.bonusClaimed = true; state.ash += window.DAILY_BONUS; save();
      return window.DAILY_BONUS;
    },
    /** Секунд до обновления заданий (полночь по местному времени). */
    secondsToReset() {
      const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
      return Math.max(0, Math.floor((m - n) / 1000));
    },

    // ---------- Открытие героев, карт, сложностей ----------
    /** def с полем unlock: { cost } — куплено ли; { achievement } — выполнено ли условие. */
    isUnlocked(def) {
      const u = def.unlock;
      if (!u || state.unlocked[def.id]) return true;
      if (u.cost) return false;
      return this.achProgress(window.ACHIEVEMENTS.find((a) => a.id === u.achievement)) >= 1;
    },
    buyUnlock(def) {
      const u = def.unlock;
      if (!u || !u.cost || this.isUnlocked(def) || state.ash < u.cost) return false;
      state.ash -= u.cost; state.unlocked[def.id] = true; save();
      return true;
    },

    // ---------- Мастерство оружия ----------
    mastery(id) { return state.mastery[id] || 0; },
    masteryCost(id) { const M = window.WEAPON_MASTERY, l = this.mastery(id); return l >= M.max ? 0 : M.cost(l); },
    weaponDamageMul(id) { return 1 + this.mastery(id) * window.WEAPON_MASTERY.dmgPerLevel; },
    upgradeMastery(id) {
      const c = this.masteryCost(id);
      if (!c || state.ash < c || !this.weaponFound(id)) return false;
      state.ash -= c; state.mastery[id] = this.mastery(id) + 1; save();
      return true;
    },
    /** Редкое оружие открывается, когда впервые найдено в сундуке. */
    weaponFound(id) { return id !== 'lightning' || state.stats.lightning > 0; },

    // ---------- Статистика, бестиарий, достижения ----------
    get stats() { return state.stats; },
    statValue(stat) {
      if (stat === 'heroesUnlocked') return window.HEROES.filter((h) => this.isUnlocked(h)).length;
      if (stat.indexOf('boss_') === 0) return state.bestiary[stat.slice(5)] || 0;
      return state.stats[stat] || 0;
    },
    seen(type) { return state.bestiary[type] || 0; },
    /** Доля выполнения 0…1. */
    achProgress(a) { return Math.min(1, this.statValue(a.stat) / a.goal); },
    achClaimed(a) { return !!state.achClaimed[a.id]; },
    claimAchievement(a) {
      if (this.achClaimed(a) || this.achProgress(a) < 1) return 0;
      state.achClaimed[a.id] = true; state.ash += a.reward; save();
      return a.reward;
    },
    achClaimable() { return window.ACHIEVEMENTS.filter((a) => !this.achClaimed(a) && this.achProgress(a) >= 1).length; },

    // ---------- Профиль, аккаунт, выбор забега ----------
    get profile() { return state.profile; },
    setName(n) { state.profile.name = (n || '').trim().slice(0, 16) || 'Странник'; save(); },
    get account() { return state.account; },
    get sel() { return state.sel; },
    select(key, value) { state.sel[key] = value; save(); },
    toggleMod(id) {
      const m = state.sel.mods, i = m.indexOf(id);
      if (i >= 0) m.splice(i, 1); else m.push(id);
      save();
    },
    /** Бонус пепла от карты, сложности и модификаторов. */
    runAshBonus(sel) {
      const map = window.MAPS.find((x) => x.id === sel.map) || window.MAPS[0];
      const dif = window.DIFFICULTIES.find((x) => x.id === sel.difficulty) || window.DIFFICULTIES[0];
      let b = (map.ash || 0) + dif.ash;
      for (const id of sel.mods) { const m = window.MODIFIERS.find((x) => x.id === id); if (m) b += m.ash; }
      return b;
    },

    /**
     * Конец забега: награда пеплом, статистика, бестиарий, задания дня, опыт аккаунта.
     * rs: { kills, time, level, elites, bosses, gems, byType: {тип: n}, bossIds: [...], lightning }
     * run: { map, difficulty, mods } — выбранные условия забега.
     */
    finishRun(heroId, rs, run) {
      const b = this.bonuses(heroId);
      const parts = [
        ['Убийства', Math.floor(rs.kills / 8)],
        ['Время', Math.floor(rs.time / 60 * 6)],
        ['Элиты', rs.elites * 3],
        ['Боссы', rs.bosses * 40],
      ];
      let base = 0;
      for (const p of parts) base += p[1];
      const runBonus = run ? this.runAshBonus(run) : 0;
      const total = Math.round(base * (1 + b.ash + runBonus));
      state.ash += total;

      // постоянная статистика и бестиарий (до проверки достижений)
      const achBefore = window.ACHIEVEMENTS.filter((a) => this.achProgress(a) >= 1).map((a) => a.id);
      const st = state.stats;
      st.kills += rs.kills; st.elites += rs.elites; st.totalAsh += total;
      if (rs.time >= 60) st.runs++;
      st.bestTime = Math.max(st.bestTime, rs.time); st.bestLevel = Math.max(st.bestLevel, rs.level);
      if (rs.lightning) st.lightning = 1;
      if (rs.byType) for (const t in rs.byType) state.bestiary[t] = (state.bestiary[t] || 0) + rs.byType[t];
      if (rs.bossIds) for (const id of rs.bossIds) state.bestiary[id] = (state.bestiary[id] || 0) + 1;
      const newAch = window.ACHIEVEMENTS.filter((a) => this.achProgress(a) >= 1 && achBefore.indexOf(a.id) < 0).map((a) => a.name);

      // уровень аккаунта: опыт = заработанный пепел
      const acc = state.account, levelBefore = acc.level;
      acc.xp += total;
      while (acc.xp >= window.ACCOUNT.xpFor(acc.level)) { acc.xp -= window.ACCOUNT.xpFor(acc.level); acc.level++; }

      const d = rollDaily(), completed = [];
      // забег короче минуты не засчитывается в задания «сыграй N забегов»
      const counted = rs.time >= 60 ? 1 : 0;
      const stats = Object.assign({ runs: counted }, rs);
      for (const q of d.quests) {
        const def = questDef(q);
        const was = this.questInfo(q).done;
        if (def.hero && q.hero !== heroId) continue;
        const v = def.hero ? counted : stats[def.stat] || 0;
        q.progress = def.kind === 'sum' ? q.progress + v : Math.max(q.progress, v);
        if (!was && this.questInfo(q).done) completed.push(this.questInfo(q).text);
      }
      save();
      return {
        total, parts: parts.filter((p) => p[1] > 0), bonusPct: Math.round((b.ash + runBonus) * 100), completed,
        achievements: newAch, accountLevel: acc.level > levelBefore ? acc.level : 0,
      };
    },

    /** Полный сброс прогресса (из настроек, с подтверждением на странице). */
    resetAll() {
      try { localStorage.removeItem(KEY); } catch (e) { /* приватный режим */ }
      const fresh = load();
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, fresh);
      save();
    },
  };

  window.Meta = Meta;
})();
