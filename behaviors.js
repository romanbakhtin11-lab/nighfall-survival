'use strict';
/*
 * Переиспользуемые модули поведения.
 *
 * EnemyBehaviors[name].update(e, g, dt, P) — выставляет желаемую скорость e.vx/e.vy
 * (движение, отталкивание и препятствия обрабатывает игра). P — params из enemies.js.
 *
 * BossAbilities[name] — способность босса:
 *   start(b, g, A)        — в начале предупреждения (выбор цели, разметка)
 *   warn(ctx, b, g, A, t, ox, oy) — рисует предупреждение, t — прогресс 0..1
 *   act(b, g, A, dt)      — исполнение; возвращает true, когда закончено
 * A — параметры способности из bosses.js.
 */
(function () {
  const TAU = Math.PI * 2;

  function toPlayer(e, g) {
    const dx = g.player.x - e.x, dy = g.player.y - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    e.dirX = dx / d; e.dirY = dy / d;
    return d;
  }

  const EnemyBehaviors = {
    /** Идёт прямо на игрока. */
    chase: {
      update(e, g) {
        toPlayer(e, g);
        e.vx = e.dirX * e.speed; e.vy = e.dirY * e.speed;
      },
    },

    /** Летит к игроку, покачиваясь из стороны в сторону. */
    flyer: {
      update(e, g, dt, P) {
        toPlayer(e, g);
        const w = Math.sin(g.time * P.freq + e.seed * 6) * P.wobble;
        const vx = e.dirX - e.dirY * w, vy = e.dirY + e.dirX * w, l = Math.hypot(vx, vy) || 1;
        e.vx = vx / l * e.speed; e.vy = vy / l * e.speed;
      },
    },

    /** Подбирается, замирает с предупреждением и делает рывок. */
    dasher: {
      update(e, g, dt, P) {
        if (e.cd > 0) e.cd -= dt;
        if (e.state === 0) {
          const d = toPlayer(e, g);
          e.vx = e.dirX * e.speed; e.vy = e.dirY * e.speed;
          if (d < P.range && e.cd <= 0) { e.state = 1; e.timer = P.windup; e.ax = e.dirX; e.ay = e.dirY; }
        } else if (e.state === 1) {
          e.vx = 0; e.vy = 0; e.tele = true;
          if ((e.timer -= dt) <= 0) { e.state = 2; e.timer = P.time; }
        } else {
          e.tele = false;
          e.vx = e.ax * P.speed; e.vy = e.ay * P.speed;
          e.dirX = e.ax; e.dirY = e.ay;
          if ((e.timer -= dt) <= 0) { e.state = 0; e.cd = P.cooldown; }
        }
      },
    },

    /** Держит дистанцию и стреляет; перед выстрелом натягивает тетиву. */
    ranged: {
      update(e, g, dt, P) {
        const d = toPlayer(e, g);
        let k = 0;
        if (d > P.keep + 15) k = 1; else if (d < P.keep - 15) k = -0.8;
        const side = e.seed > 0.5 ? 1 : -1;
        e.vx = (e.dirX * k - e.dirY * side * 0.5) * e.speed;
        e.vy = (e.dirY * k + e.dirX * side * 0.5) * e.speed;
        if (e.timer <= 0) e.timer = P.every * (0.6 + e.seed * 0.8);
        e.timer -= dt;
        e.tele = e.timer < P.windup && d < P.keep * 2.2;
        if (e.timer <= 0 && d < P.keep * 2.2) {
          g.spawnEnemyProjectile(e.x, e.y - 8, e.dirX * P.projSpeed, e.dirY * P.projSpeed, P.projDmg * e.dmgMul, P.proj, P.glow);
          e.timer = P.every;
        }
      },
    },

    /** Подбегает и взрывается после короткого запала. */
    exploder: {
      update(e, g, dt, P) {
        const d = toPlayer(e, g);
        if (e.state === 0) {
          e.vx = e.dirX * e.speed; e.vy = e.dirY * e.speed;
          if (d < P.range) { e.state = 1; e.timer = P.fuse; }
        } else {
          e.vx *= 0.85; e.vy *= 0.85; e.tele = true;
          if ((e.timer -= dt) <= 0) {
            g.explode(e.x, e.y - 4, P.radius * e.scale, P.dmg * e.dmgMul);
            g.killEnemy(e);
          }
        }
      },
    },
  };

  // ---------------------------------------------------------------------
  // Помощники рисования предупреждений (низкое разрешение, additive)
  // ---------------------------------------------------------------------
  function ringWarn(ctx, x, y, r, t, color) {
    ctx.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(t * 18));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.18 + t * 0.3;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r * t, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  const BossAbilities = {
    /** Рывок через экран по заранее показанной линии. */
    dash: {
      start(b, g) {
        const dx = g.player.x - b.x, dy = g.player.y - b.y, d = Math.hypot(dx, dy) || 1;
        b.ax = dx / d; b.ay = dy / d;
      },
      warn(ctx, b, g, A, t, ox, oy) {
        const len = A.speed * A.time, x = b.x - ox, y = b.y - oy - 10;
        ctx.globalAlpha = 0.25 + 0.35 * Math.abs(Math.sin(t * 16));
        ctx.strokeStyle = '#dc4a3a';
        ctx.lineWidth = b.r * 1.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + b.ax * len, y + b.ay * len); ctx.stroke();
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1; ctx.strokeStyle = '#f5856a';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + b.ax * len * t, y + b.ay * len * t); ctx.stroke();
        ctx.globalAlpha = 1;
      },
      act(b, g, A, dt) {
        if (b.actT === 0) b.dashHit = false;
        b.vx = b.ax * A.speed; b.vy = b.ay * A.speed;
        b.dashDmg = A.dmg;
        b.dashing = true;
        if (b.actT >= A.time) { b.dashing = false; b.vx = 0; b.vy = 0; return true; }
        return false;
      },
    },

    /** Кольцо (или два) снарядов во все стороны. */
    radialVolley: {
      start() {},
      warn(ctx, b, g, A, t, ox, oy) {
        ringWarn(ctx, b.x - ox, b.y - oy - b.h * 0.4, 6 + (1 - t) * 30, t, b.glowHex);
      },
      act(b, g, A) {
        const rings = A.rings || 1;
        for (let r = 0; r < rings; r++) {
          const off = r * Math.PI / A.count, sp = A.speed * (1 - r * 0.25);
          for (let k = 0; k < A.count; k++) {
            const a = off + k * TAU / A.count;
            g.spawnEnemyProjectile(b.x, b.y - b.h * 0.4, Math.cos(a) * sp, Math.sin(a) * sp, A.dmg, A.proj, A.glow);
          }
        }
        return true;
      },
    },

    /** Спираль снарядов из нескольких «рукавов». */
    spiral: {
      start(b) { b.spin = Math.random() * TAU; b.emit = 0; },
      warn(ctx, b, g, A, t, ox, oy) {
        ringWarn(ctx, b.x - ox, b.y - oy - b.h * 0.4, 8 + t * 12, t, b.glowHex);
      },
      act(b, g, A, dt) {
        b.vx = 0; b.vy = 0;
        b.emit -= dt;
        if (b.emit <= 0) {
          b.emit = A.rate;
          for (let k = 0; k < A.arms; k++) {
            const a = b.spin + k * TAU / A.arms;
            g.spawnEnemyProjectile(b.x, b.y - b.h * 0.4, Math.cos(a) * A.speed, Math.sin(a) * A.speed, A.dmg, A.proj, A.glow);
          }
          b.spin += 0.32;
        }
        return b.actT >= A.time;
      },
    },

    /** Призыв миньонов: сначала на земле проступают печати. */
    summon: {
      start(b, g, A) {
        b.markCount = Math.min(A.count, b.marks.length / 2);
        for (let k = 0; k < b.markCount; k++) {
          const a = k / b.markCount * TAU + Math.random() * 0.4;
          b.marks[k * 2] = b.x + Math.cos(a) * A.radius;
          b.marks[k * 2 + 1] = b.y + Math.sin(a) * A.radius * 0.8;
        }
      },
      warn(ctx, b, g, A, t, ox, oy) {
        for (let k = 0; k < b.markCount; k++) ringWarn(ctx, b.marks[k * 2] - ox, b.marks[k * 2 + 1] - oy, 9, t, '#9a58c4');
      },
      act(b, g, A) {
        for (let k = 0; k < b.markCount; k++) {
          g.spawnEnemy(A.type, b.marks[k * 2], b.marks[k * 2 + 1], false);
          g.spawnParticles(b.marks[k * 2], b.marks[k * 2 + 1] - 6, '#9a58c4', 6);
        }
        return true;
      },
    },

    /** Зоны урона на земле: одна под игроком, остальные рядом. */
    zones: {
      start() {},
      warn(ctx, b, g, A, t, ox, oy) {
        ringWarn(ctx, b.x - ox, b.y - oy - b.h * 0.4, 10, t, b.glowHex);
      },
      act(b, g, A) {
        const p = g.player;
        for (let k = 0; k < A.count; k++) {
          const a = Math.random() * TAU, d = k === 0 ? 0 : 25 + Math.random() * A.spread;
          g.spawnZone(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, A.radius, A.windup, A.duration, A.dps, A.color);
        }
        return true;
      },
    },

    /** Притягивает игрока к себе. */
    pull: {
      start() {},
      warn(ctx, b, g, A, t, ox, oy) {
        const x = b.x - ox, y = b.y - oy - b.h * 0.3;
        for (let k = 0; k < 3; k++) ringWarn(ctx, x, y, 20 + ((1 - t + k / 3) % 1) * 80, t, b.glowHex);
      },
      act(b, g, A, dt) {
        b.vx = 0; b.vy = 0;
        const p = g.player, dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy) || 1;
        p.extVX += dx / d * A.force; p.extVY += dy / d * A.force;
        if (Math.random() < 0.5) g.spawnParticles(p.x + (Math.random() - 0.5) * 60, p.y + (Math.random() - 0.5) * 60, b.glowHex, 1);
        return b.actT >= A.time;
      },
    },

    /** Ударная волна: отталкивает и ранит вблизи. */
    shockwave: {
      start() {},
      warn(ctx, b, g, A, t, ox, oy) {
        ringWarn(ctx, b.x - ox, b.y - oy, A.radius, t, '#dc4a3a');
      },
      act(b, g, A) {
        const p = g.player, dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) || 1;
        if (d < A.radius) {
          g.hurtPlayer(A.dmg);
          p.knockX += dx / d * A.push; p.knockY += dy / d * A.push;
        }
        g.spawnRing(b.x, b.y, A.radius, 'fire');
        g.shake(6);
        return true;
      },
    },

    /** Неуязвимость на время и призыв защитников. */
    shield: {
      start(b, g, A) { BossAbilities.summon.start(b, g, A); },
      warn(ctx, b, g, A, t, ox, oy) {
        ringWarn(ctx, b.x - ox, b.y - oy - b.h * 0.4, b.r * 2, t, '#78d0e0');
        BossAbilities.summon.warn(ctx, b, g, A, t, ox, oy);
      },
      act(b, g, A) {
        b.invuln = A.time;
        BossAbilities.summon.act(b, g, A);
        return true;
      },
    },
  };

  window.EnemyBehaviors = EnemyBehaviors;
  window.BossAbilities = BossAbilities;
})();
