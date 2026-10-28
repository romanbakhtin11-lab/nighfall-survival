'use strict';
/*
 * Единая палитра игры (≤ 64 цвета).
 * Цвета сгруппированы в «рампы» — от глубокой тени к блику.
 * Спрайты и тайлы хранят только индексы палитры, поэтому палитру
 * можно перекрасить целиком, не трогая генераторы.
 */
(function () {
  const RAMPS = {
    ink:    ['#0d0a14'],
    white:  ['#ffffff'],
    stone:  ['#2e2b3a', '#4a4658', '#6e6a7c', '#9a96a6', '#c6c2cc'],
    grass:  ['#1c2b1e', '#2b4229', '#3f5e33', '#5a7d3c', '#86a34a'],
    dirt:   ['#2e1f1a', '#4a3226', '#6b4a32', '#8f6a45', '#b48d5c'],
    wood:   ['#2e1f1a', '#46291c', '#6a4128', '#8f6a45'],
    skin:   ['#5a2e24', '#94553a', '#c98a62', '#efc39a'],
    bone:   ['#4c4436', '#7f7560', '#b8ad8c', '#e8e0c4'],
    steel:  ['#232533', '#4a5068', '#7c86a2', '#b8c2d6', '#eef2f8'],
    gold:   ['#4a2a10', '#8a5418', '#cf8d26', '#f4c95a', '#fff2b0'],
    red:    ['#3a0c14', '#6e1622', '#a8262c', '#dc4a3a', '#f5856a'],
    blue:   ['#141a3c', '#22346e', '#3657a8', '#5b8ae0'],
    purple: ['#200f30', '#3e1d58', '#6a3290', '#9a58c4', '#d095f0'],
    toxic:  ['#12301c', '#1f5a2a', '#3a9a3a', '#7fd450', '#d4ff8a'],
    fire:   ['#5a1408', '#a8320c', '#ec6a14', '#f4c95a', '#fff2b0'],
    ice:    ['#0e2a3a', '#1c5470', '#3a92b0', '#78d0e0', '#d0f6ff'],
    // составные рампы из уже существующих цветов
    ghoul:  ['#2b4229', '#3f5e33', '#7f7560', '#b8ad8c'],
    night:  ['#0d0a14', '#200f30', '#2e2b3a', '#4a4658'],
  };

  // индекс 0 — прозрачный пиксель
  const colors = [null];
  const lookup = Object.create(null);
  const ramps = {};
  for (const name in RAMPS) {
    ramps[name] = RAMPS[name].map((hex) => {
      if (!(hex in lookup)) { lookup[hex] = colors.length; colors.push(hex); }
      return lookup[hex];
    });
  }
  if (colors.length - 1 > 64) console.warn('Палитра больше 64 цветов:', colors.length - 1);

  // RGBA в порядке байтов ImageData (little-endian Uint32: 0xAABBGGRR)
  const rgba = new Uint32Array(colors.length);
  for (let i = 1; i < colors.length; i++) {
    const h = colors[i];
    const r = parseInt(h.substr(1, 2), 16), g = parseInt(h.substr(3, 2), 16), b = parseInt(h.substr(5, 2), 16);
    rgba[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  window.Palette = {
    colors,            // индекс → '#rrggbb'
    rgba,              // индекс → Uint32 для ImageData
    ramps,             // имя → [индексы от тени к блику]
    hex: RAMPS,        // имя → ['#…'] (для CSS/канваса)
    INK: ramps.ink[0],
    WHITE: ramps.white[0],
    size: colors.length - 1,
  };
})();
