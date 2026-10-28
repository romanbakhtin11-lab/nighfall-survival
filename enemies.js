'use strict';
/*
 * Мобы — только данные. Поведение задаётся именем модуля из behaviors.js
 * (behavior) и его параметрами (params), поэтому новый моб — это новая запись.
 *
 * r       — радиус столкновения (в пикселях арта)
 * dmg     — урон за удар при касании (не чаще раза в 0.6 с)
 * unlock  — секунда, с которой моб начинает появляться
 * weight  — относительная частота появления
 * flying  — летает: игнорирует препятствия, тень отстаёт от тела
 * onDeath — { split: тип, count } — распадается на мелких
 * elite   — может появиться в элитной версии
 */
window.ENEMIES = {
  ghoul: {
    lore: 'Мертвец, поднятый Роем. Медленный, но их всегда много.',
    name: 'Гнилец', sprite: 'ghoul', color: '#6e7a56',
    hp: 9, speed: 46, dmg: 8, xp: 1, r: 7, knockRes: 1,
    behavior: 'chase', unlock: 0, weight: 10, elite: true,
  },
  bat: {
    lore: 'Летает стаями, меняет курс в последний миг. Не замечает стен.',
    name: 'Нетопырь', sprite: 'bat', color: '#9a58c4',
    hp: 4, speed: 82, dmg: 5, xp: 1, r: 6, knockRes: 1.3, flying: true, hover: 10,
    behavior: 'flyer', params: { wobble: 1.4, freq: 5 }, unlock: 20, weight: 7, elite: true,
  },
  hound: {
    lore: 'Тлеющий волк. Замирает, вспыхивает красным — и бросается.',
    name: 'Пепельная гончая', sprite: 'hound', color: '#6e6a7c',
    hp: 16, speed: 58, dmg: 12, xp: 2, r: 8, knockRes: 0.9,
    behavior: 'dasher', params: { range: 85, windup: 0.55, speed: 230, time: 0.35, cooldown: 2.4 },
    unlock: 55, weight: 5, elite: true,
  },
  archer: {
    lore: 'Держится на расстоянии и пускает костяные стрелы.',
    name: 'Скелет-лучник', sprite: 'archer', color: '#b8ad8c',
    hp: 12, speed: 42, dmg: 6, xp: 2, r: 7, knockRes: 1,
    behavior: 'ranged', params: { keep: 105, every: 2.4, windup: 0.45, projSpeed: 105, projDmg: 9, proj: 'bonearrow', glow: 'purple' },
    unlock: 90, weight: 4, elite: true,
  },
  slime: {
    lore: 'Чумная капля с черепом внутри. Убитая, распадается на три.',
    name: 'Чумной слизень', sprite: 'slime', color: '#3a9a3a',
    hp: 24, speed: 34, dmg: 10, xp: 3, r: 8, knockRes: 0.7,
    behavior: 'chase', onDeath: { split: 'slimelet', count: 3 }, unlock: 120, weight: 4, elite: true,
  },
  slimelet: {
    lore: 'Осколок чумного слизня: мелкий, быстрый и злой.',
    name: 'Слизнёнок', sprite: 'slimelet', color: '#7fd450',
    hp: 5, speed: 58, dmg: 4, xp: 1, r: 5, knockRes: 1.3,
    behavior: 'chase', unlock: Infinity, weight: 0,
  },
  golem: {
    lore: 'Каменная громада из кургана. Почти не отступает от ударов.',
    name: 'Курганный голем', sprite: 'golem', color: '#9a96a6',
    hp: 95, speed: 24, dmg: 20, xp: 8, r: 12, knockRes: 0.15,
    behavior: 'chase', unlock: 150, weight: 2, elite: true,
  },
  ghost: {
    lore: 'Ледяное покрывало, проходящее сквозь камень и деревья.',
    name: 'Блуждающий дух', sprite: 'ghost', color: '#78d0e0',
    hp: 20, speed: 36, dmg: 9, xp: 3, r: 7, knockRes: 0.6, flying: true, hover: 6, alpha: 0.72,
    behavior: 'flyer', params: { wobble: 0.6, freq: 2 }, unlock: 200, weight: 3, elite: true,
  },
  imp: {
    lore: 'Подбегает, раскаляется и взрывается. Не стой рядом.',
    name: 'Бес-подрывник', sprite: 'imp', color: '#ec6a14',
    hp: 10, speed: 66, dmg: 6, xp: 2, r: 6, knockRes: 1,
    behavior: 'exploder', params: { range: 26, fuse: 0.75, radius: 34, dmg: 22 },
    unlock: 240, weight: 3, elite: true,
  },
};

/** Множители элитной версии. */
window.ELITE = { scale: 1.4, hp: 6, dmg: 1.5, xp: 8, speed: 0.95 };
