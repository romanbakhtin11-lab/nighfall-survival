'use strict';
/*
 * Герои — только данные. Чтобы добавить героя:
 *   1) нарисуйте спрайт 'hero_<sprite>' в sprites.js (или положите PNG в атлас),
 *   2) добавьте запись сюда.
 * stats — базовые характеристики, perk — пассивная особенность (текст + модификаторы).
 * unlock — как открыть: { cost } за пепел или { achievement, text } — по условию; нет поля — открыт сразу.
 */
window.HEROES = [
  {
    id: 'knight',
    name: 'Ольгерд',
    title: 'Пепельный рыцарь',
    sprite: 'hero_knight',
    color: '#5b8ae0',
    weapon: 'sword',
    stats: { hp: 140, speed: 100, magnet: 44, armor: 3, regen: 0, might: 1 },
    perk: 'Броня: −3 урона от каждого удара, +40 здоровья',
    lore: 'Последний из ордена Пепла. Щит видел сорок ночей и не треснул.',
  },
  {
    id: 'witch',
    name: 'Мирра',
    title: 'Ведьма пепла',
    sprite: 'hero_witch',
    color: '#9a58c4',
    weapon: 'bolt',
    stats: { hp: 90, speed: 108, magnet: 58, armor: 0, regen: 0, might: 1.2 },
    perk: 'Сила чар: +20% к урону, увеличенный радиус сбора',
    lore: 'Читает руны в золе и бьёт тем, что прочла. Хрупкая, но опасная.',
  },
  {
    id: 'huntress',
    name: 'Ясна',
    title: 'Лесная охотница',
    sprite: 'hero_huntress',
    color: '#5a7d3c',
    weapon: 'arrows',
    stats: { hp: 100, speed: 128, magnet: 44, armor: 0, regen: 0, might: 1 },
    perk: 'Лёгкая поступь: +25% к скорости передвижения',
    lore: 'Ушла в лес до того, как погасло солнце. Стреляет раньше, чем видит.',
    unlock: { cost: 300 },
  },
  {
    id: 'gravedigger',
    name: 'Хорн',
    title: 'Могильщик',
    sprite: 'hero_gravedigger',
    color: '#ffae3a',
    weapon: 'nova',
    stats: { hp: 115, speed: 96, magnet: 72, armor: 1, regen: 1.2, might: 1 },
    perk: 'Живучесть: восстанавливает 1.2 здоровья в секунду, большой радиус сбора',
    lore: 'Хоронил павших до первой ночи. Теперь его фонарь — последний свет у курганов.',
    unlock: { achievement: 'boss_reaper', text: 'Победи Мора, Костяного Жнеца' },
  },
];
