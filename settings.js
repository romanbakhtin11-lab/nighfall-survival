'use strict';
/*
 * Настройки игрока: хранятся отдельно от прогресса, применяются сразу.
 *   music, sfx   — включены ли музыка и звуки (сами флаги живут в audio.js)
 *   vibration    — короткая вибрация при ранении и новом уровне (если устройство умеет)
 *   quality      — 'high' | 'low': на низком меньше частиц и свечений, фон меню проще
 *   reduceMotion — без анимаций меню и переходов (по умолчанию — как в системе)
 */
(function () {
  const KEY = 'night-swarm-settings';
  const sysReduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { st = {}; }
  st = Object.assign({ vibration: true, quality: 'high', reduceMotion: sysReduce }, st);

  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* приватный режим */ } }
  function applyBody() {
    if (!document.body) return;
    document.body.classList.toggle('reduce-motion', st.reduceMotion);
    document.body.classList.toggle('low-quality', st.quality === 'low');
  }

  window.Settings = {
    get vibration() { return st.vibration; },
    get quality() { return st.quality; },
    get reduceMotion() { return st.reduceMotion; },
    get canVibrate() { return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'; },
    set(key, value) { st[key] = value; save(); applyBody(); },
    vibrate(ms) { if (st.vibration && this.canVibrate) { try { navigator.vibrate(ms); } catch (e) { /* запрещено */ } } },
    applyBody,
  };
  window.addEventListener('DOMContentLoaded', applyBody);
})();
