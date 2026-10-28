'use strict';
/*
 * Прокачка в меню — только данные.
 *   HERO_UPGRADE — уровни героев: бонусы за уровень и цены.
 *   ITEMS        — предметы снаряжения: действуют на всех героев, у каждого свой максимум.
 *   DAILY_POOL   — шаблоны ежедневных заданий; каждый день выбираются 3 разных.
 * Валюта — «пепел»: даётся за забеги и задания.
 */
(function () {
  window.HERO_UPGRADE = {
    maxLevel: 10,
    hpPerLevel: 0.06,      // +6% здоровья за уровень
    mightPerLevel: 0.04,   // +4% урона за уровень
    weaponAt: [4, 8],      // на этих уровнях стартовое оружие сразу на +1
    cost(level) { return Math.round(60 * Math.pow(1.45, level - 1) / 5) * 5; },
  };

  // apply(bonus, level) — накапливает эффект в объект бонусов (см. Meta.bonuses)
  window.ITEMS = [
    { id: 'heart', name: 'Янтарное сердце', icon: 'hp', max: 5, base: 50,
      text: (l) => '+' + 8 * l + ' здоровья', apply: (b, l) => { b.hp += 8 * l; } },
    { id: 'ring', name: 'Кольцо пепла', icon: 'ring', max: 5, base: 70,
      text: (l) => '+' + 5 * l + '% урона', apply: (b, l) => { b.might += 0.05 * l; } },
    { id: 'boots', name: 'Сапоги странника', icon: 'speed', max: 5, base: 50,
      text: (l) => '+' + 4 * l + '% скорости', apply: (b, l) => { b.speed += 0.04 * l; } },
    { id: 'stone', name: 'Камень притяжения', icon: 'magnet', max: 5, base: 40,
      text: (l) => '+' + 12 * l + '% радиуса сбора', apply: (b, l) => { b.magnet += 0.12 * l; } },
    { id: 'tome', name: 'Том знаний', icon: 'tome', max: 5, base: 80,
      text: (l) => '+' + 6 * l + '% опыта', apply: (b, l) => { b.xp += 0.06 * l; } },
    { id: 'herb', name: 'Целебные травы', icon: 'herb', max: 5, base: 90,
      text: (l) => '+' + (0.2 * l).toFixed(1) + ' здоровья/с', apply: (b, l) => { b.regen += 0.2 * l; } },
    { id: 'shell', name: 'Панцирь голема', icon: 'shell', max: 3, base: 120,
      text: (l) => '+' + l + ' брони', apply: (b, l) => { b.armor += l; } },
    { id: 'clover', name: 'Ведьмин клевер', icon: 'clover', max: 5, base: 70,
      text: (l) => l * 8 + '% шанс 4-й карточки улучшений', apply: (b, l) => { b.luck += 0.08 * l; } },
    { id: 'coin', name: 'Медная монета', icon: 'coin', max: 5, base: 60,
      text: (l) => '+' + 10 * l + '% пепла за забег', apply: (b, l) => { b.ash += 0.1 * l; } },
  ];
  window.itemCost = (item, level) => Math.round(item.base * Math.pow(1.6, level) / 5) * 5;

  // kind: 'sum' — копится за все забеги дня, 'best' — лучший результат за один забег.
  // stat — поле статистики забега (см. Game.runStats). targets/rewards — варианты сложности.
  window.DAILY_POOL = [
    { id: 'kills', kind: 'sum', stat: 'kills', targets: [300, 600, 1000], rewards: [30, 50, 80], text: (n) => 'Убей ' + n + ' врагов' },
    { id: 'elites', kind: 'sum', stat: 'elites', targets: [4, 8, 14], rewards: [35, 55, 85], text: (n) => 'Убей ' + n + ' элитных врагов' },
    { id: 'boss', kind: 'sum', stat: 'bosses', targets: [1, 2], rewards: [70, 120], text: (n) => n > 1 ? 'Победи ' + n + ' боссов' : 'Победи босса' },
    { id: 'survive', kind: 'best', stat: 'time', targets: [240, 420, 600], rewards: [30, 55, 90], text: (n) => 'Продержись ' + Math.round(n / 60) + ' мин за один забег' },
    { id: 'gems', kind: 'sum', stat: 'gems', targets: [400, 800, 1500], rewards: [25, 45, 70], text: (n) => 'Собери ' + n + ' кристаллов' },
    { id: 'level', kind: 'best', stat: 'level', targets: [10, 15, 22], rewards: [30, 50, 80], text: (n) => 'Достигни ' + n + ' уровня за один забег' },
    { id: 'runs', kind: 'sum', stat: 'runs', targets: [2, 3], rewards: [25, 40], text: (n) => 'Сыграй ' + n + ' забега' },
    { id: 'hero', kind: 'sum', stat: 'heroRuns', hero: true, targets: [1, 2], rewards: [30, 50], text: (n, h) => 'Сыграй ' + (n > 1 ? n + ' забега' : 'забег') + ' за героя ' + h },
  ];
  window.DAILY_BONUS = 60;   // за выполнение всех трёх заданий дня

  // ---------- Мастерство оружия: постоянный бонус урона из «Арсенала» ----------
  window.WEAPON_MASTERY = { max: 3, dmgPerLevel: 0.1, cost: (l) => [120, 260, 520][l] };

  // ---------- Подготовка к забегу ----------
  // ambient — цвет ночного multiply-слоя; world — пороги поверхностей для World
  window.MAPS = [
    { id: 'wastes', name: 'Пепельный предел', icon: 'map_wastes', seed: 1337, ambient: '#9d97c4',
      world: {}, desc: 'Луга, тропы и редкие каменные плато. Здесь всё началось.' },
    { id: 'barrows', name: 'Каменные курганы', icon: 'map_barrows', seed: 4242, ambient: '#8f9ab8',
      world: { dirt: 0.55, stone: 0.52, decor: 1.25 }, ash: 0.2,
      desc: 'Голая земля и лабиринт плато. Тесно, мобы выходят из-за камней. +20% пепла.',
      unlock: { achievement: 'survive_10', text: 'Продержись 10 минут' } },
  ];
  window.DIFFICULTIES = [
    { id: 'normal', name: 'Сумерки', hp: 1, dmg: 1, ash: 0, desc: 'Обычная ночь.' },
    { id: 'hard', name: 'Глухая ночь', hp: 1.5, dmg: 1.3, ash: 0.5, desc: 'Враги крепче на 50% и бьют больнее. +50% пепла.' },
    { id: 'nightmare', name: 'Кошмар', hp: 2.3, dmg: 1.7, ash: 1.2, desc: 'Для тех, кто видел рассвет. +120% пепла.',
      unlock: { achievement: 'boss_ashgar', text: 'Победи Ашгара' } },
  ];
  // эффекты применяются в Game.startRun
  window.MODIFIERS = [
    { id: 'glass', name: 'Стеклянная пушка', icon: 'might', ash: 0.25, desc: 'Урон +50%, здоровье −50%. +25% пепла.' },
    { id: 'horde', name: 'Голодная орда', icon: 'skull', ash: 0.3, desc: 'Врагов на 50% больше. +30% пепла.' },
    { id: 'haste', name: 'Бешеная ночь', icon: 'speed', ash: 0.2, desc: 'Враги быстрее на 20%. +20% пепла.' },
  ];

  // ---------- Достижения ----------
  // stat — поле постоянной статистики (Meta.stats); goal — цель; reward — пепел
  window.ACHIEVEMENTS = [
    { id: 'kills_100', name: 'Первая кровь', icon: 'skull', stat: 'kills', goal: 100, reward: 20 },
    { id: 'kills_2000', name: 'Жатва', icon: 'skull', stat: 'kills', goal: 2000, reward: 80 },
    { id: 'kills_20000', name: 'Гроза Роя', icon: 'skull', stat: 'kills', goal: 20000, reward: 300 },
    { id: 'survive_5', name: 'Полночь', icon: 'scroll', stat: 'bestTime', goal: 300, reward: 40, time: true },
    { id: 'survive_10', name: 'Глубокая ночь', icon: 'scroll', stat: 'bestTime', goal: 600, reward: 100, time: true },
    { id: 'survive_20', name: 'Рассвет', icon: 'scroll', stat: 'bestTime', goal: 1200, reward: 400, time: true },
    { id: 'elites_25', name: 'Охотник на элиту', icon: 'ring', stat: 'elites', goal: 25, reward: 60 },
    { id: 'boss_reaper', name: 'Мор повержен', icon: 'boss_reaper', stat: 'boss_reaper', goal: 1, reward: 100 },
    { id: 'boss_queen', name: 'Королева пала', icon: 'boss_queen', stat: 'boss_queen', goal: 1, reward: 150 },
    { id: 'boss_ashgar', name: 'Пламя угасло', icon: 'boss_ashgar', stat: 'boss_ashgar', goal: 1, reward: 250 },
    { id: 'level_25', name: 'Восхождение', icon: 'tome', stat: 'bestLevel', goal: 25, reward: 60 },
    { id: 'runs_10', name: 'Завсегдатай ночи', icon: 'ash', stat: 'runs', goal: 10, reward: 50 },
    { id: 'heroes_all', name: 'Отряд в сборе', icon: 'hp', stat: 'heroesUnlocked', goal: 4, reward: 120 },
    { id: 'lightning', name: 'Пойманная молния', icon: 'lightning', stat: 'lightning', goal: 1, reward: 40 },
  ];

  // уровень аккаунта: опыт = заработанный пепел
  window.ACCOUNT = { xpFor: (l) => 80 + l * 60 };
})();
