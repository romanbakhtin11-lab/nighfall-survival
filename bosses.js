'use strict';
/*
 * Боссы — только данные. Каждая способность — ссылка на модуль из behaviors.js
 * (поле use) с параметрами. Фазы: вторая включается при at ≤ доле HP.
 * windup — длительность читаемого предупреждения перед атакой.
 */
(function () {
  const dash = { use: 'dash', windup: 0.9, speed: 290, time: 0.6, dmg: 22 };
  const boneRing = { use: 'radialVolley', windup: 0.7, count: 16, speed: 80, proj: 'bonearrow', glow: 'purple', dmg: 11 };

  window.BOSSES = [
    {
      id: 'reaper',
      lore: 'Скелет-король в рваной мантии. Режет косой через всё поле.',
      name: 'Мор, Костяной Жнец',
      sprite: 'reaper', glow: 'purple', color: '#9a58c4',
      time: 300, hp: 2400, speed: 52, dmg: 18, r: 16, flying: true, hover: 6,
      phases: [
        { pause: 1.6, abilities: [dash, boneRing] },
        {
          at: 0.5, speedMul: 1.4, pause: 1.0, roar: 'Жнец в ярости!',
          abilities: [dash, Object.assign({}, boneRing, { count: 22, rings: 2 }),
            { use: 'summon', windup: 0.9, type: 'archer', count: 4, radius: 70 }],
        },
      ],
    },
    {
      id: 'queen',
      lore: 'Матка Роя: зовёт нетопырей, плюётся кислотой и травит землю.',
      name: 'Королева Роя',
      sprite: 'queen', glow: 'toxic', color: '#7fd450',
      time: 600, hp: 6000, speed: 46, dmg: 22, r: 22,
      phases: [
        {
          pause: 1.5,
          abilities: [
            { use: 'summon', windup: 0.9, type: 'bat', count: 10, radius: 60 },
            { use: 'zones', windup: 1.1, count: 5, radius: 26, spread: 70, duration: 3.5, dps: 18, color: 'toxic' },
            { use: 'radialVolley', windup: 0.7, count: 14, speed: 70, proj: 'acid', glow: 'toxic', dmg: 12 },
          ],
        },
        {
          at: 0.5, speedMul: 1.35, pause: 1.0, roar: 'Королева в ярости!',
          abilities: [
            { use: 'pull', windup: 0.8, time: 2.2, force: 80 },
            { use: 'zones', windup: 1.0, count: 8, radius: 26, spread: 90, duration: 3.5, dps: 20, color: 'toxic' },
            { use: 'summon', windup: 0.9, type: 'slime', count: 5, radius: 70 },
            { use: 'radialVolley', windup: 0.6, count: 20, speed: 78, proj: 'acid', glow: 'toxic', dmg: 12, rings: 2 },
          ],
        },
      ],
    },
    {
      id: 'ashgar',
      lore: 'Демон-дракон из Бездны. Огонь, ударные волны и щит из бесов.',
      name: 'Ашгар, Пламя Бездны',
      sprite: 'ashgar', glow: 'fire', color: '#ec6a14',
      time: 900, hp: 12000, speed: 50, dmg: 26, r: 24,
      phases: [
        {
          pause: 1.4,
          abilities: [
            { use: 'spiral', windup: 0.6, time: 2.4, rate: 0.08, arms: 3, speed: 82, proj: 'fireball', glow: 'fire', dmg: 14 },
            { use: 'shockwave', windup: 1.0, radius: 95, dmg: 24, push: 280 },
            { use: 'zones', windup: 1.1, count: 6, radius: 30, spread: 85, duration: 3, dps: 24, color: 'fire' },
          ],
        },
        {
          at: 0.5, speedMul: 1.3, pause: 0.9, roar: 'Ашгар в ярости!',
          abilities: [
            { use: 'shield', windup: 0.6, time: 4, type: 'imp', count: 6, radius: 60 },
            Object.assign({}, dash, { dmg: 30, speed: 320 }),
            { use: 'spiral', windup: 0.5, time: 3, rate: 0.06, arms: 4, speed: 92, proj: 'fireball', glow: 'fire', dmg: 15 },
            { use: 'shockwave', windup: 0.9, radius: 110, dmg: 28, push: 320 },
          ],
        },
      ],
    },
  ];

  /** После последнего босса они идут по кругу каждые loop секунд, HP растёт. */
  window.BOSS_LOOP = { every: 300, hpGrowth: 0.8 };
})();
