'use strict';
/*
 * Процедурный звук на WebAudio: никаких файлов, всё синтезируется из
 * осцилляторов и шума. Sfx.play(name) — с ограничением частоты на каждый звук,
 * чтобы сотни попаданий в секунду не превращались в кашу.
 * AudioContext создаётся на первом касании (требование мобильных браузеров).
 */
(function () {
  const KEY = 'night-swarm-sound';

  let ctx = null, master = null, bus = null, noiseBuf = null;
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== '0'; } catch (e) { /* приватный режим */ }
  const last = Object.create(null);
  let voices = 0;
  const MAX_VOICES = 24;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      master = ctx.createGain();
      master.gain.value = enabled ? 0.7 : 0;
      master.connect(comp); comp.connect(ctx.destination);
      bus = comp;   // общий выход: музыка идёт мимо громкости эффектов
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
    if (window.Music) window.Music._start();
  }
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  // фоновая вкладка: глушим всё, чтобы ноты не копились и не звучали из кармана
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });

  function env(g, t, dur, vol, attack) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function done(node, t) {
    voices++;
    node.onended = () => { voices--; };
    node.stop(t);
  }

  /** Осциллятор с glide частоты f0 → f1. */
  function tone(type, f0, f1, dur, vol, delay, attack) {
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, dur, vol, attack);
    o.connect(g); g.connect(master);
    o.start(t); done(o, t + dur + 0.02);
  }

  /** Шум через фильтр, частота среза f0 → f1. */
  function noise(dur, vol, filter, f0, f1, delay, q) {
    const t = ctx.currentTime + (delay || 0);
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    f.type = filter; f.Q.value = q || 0.8;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, dur, vol);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.5); done(s, t + dur + 0.02);
  }

  function jitter(f) { return f * (0.94 + Math.random() * 0.12); }

  // [мин. интервал между повторами (с), синтез]
  const SOUNDS = {
    shoot:  [0.07, () => tone('square', jitter(990), 420, 0.06, 0.05)],
    arrow:  [0.06, () => noise(0.06, 0.12, 'bandpass', 3200, 1400, 0, 2)],
    slash:  [0.1,  () => { noise(0.13, 0.17, 'bandpass', 900, 3800, 0, 1.4); tone('triangle', jitter(260), 120, 0.08, 0.05); }],
    nova:   [0.2,  () => { tone('sine', 520, 90, 0.32, 0.22); noise(0.25, 0.08, 'lowpass', 2000, 300); }],
    zap:    [0.1,  () => { noise(0.12, 0.14, 'highpass', 5000, 2500); tone('square', 1600, 600, 0.1, 0.04); }],
    hit:    [0.035, () => noise(0.05, 0.13, 'lowpass', jitter(1800), 500)],
    kill:   [0.04, () => tone('triangle', jitter(330), 70, 0.1, 0.16)],
    elite:  [0.1,  () => { tone('square', 660, 990, 0.12, 0.08); tone('square', 990, 1320, 0.16, 0.07, 0.08); noise(0.3, 0.1, 'lowpass', 1500, 200); }],
    gem:    [0.03, (n) => tone('sine', 900 * Math.pow(1.06, n % 12), 1500 * Math.pow(1.06, n % 12), 0.06, 0.1)],
    levelup:[0.3,  () => [523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, 0.14, 0.07, i * 0.07))],
    click:  [0.05, () => tone('square', 700, 500, 0.04, 0.06)],
    hurt:   [0.12, () => { tone('sawtooth', 220, 60, 0.2, 0.14); noise(0.12, 0.1, 'lowpass', 1200, 300); }],
    boom:   [0.08, () => { noise(0.45, 0.32, 'lowpass', 1400, 80); tone('sine', 140, 40, 0.35, 0.3); }],
    eshot:  [0.12, () => tone('triangle', jitter(500), 260, 0.08, 0.05)],
    warn:   [0.5,  () => { for (let i = 0; i < 3; i++) tone('sawtooth', 110, 104, 0.32, 0.12, i * 0.5, 0.05); }],
    roar:   [0.5,  () => { tone('sawtooth', 120, 55, 0.8, 0.2, 0, 0.08); tone('sawtooth', 123, 57, 0.8, 0.14, 0, 0.08); noise(0.7, 0.18, 'lowpass', 900, 150); }],
    bossdie:[1,    () => { noise(1.4, 0.35, 'lowpass', 2400, 60); tone('sawtooth', 200, 30, 1.3, 0.2); [784, 988, 1175, 1568].forEach((f, i) => tone('triangle', f, f, 0.3, 0.08, 0.6 + i * 0.1)); }],
    chest:  [0.3,  () => [659, 784, 988, 1319, 1568].forEach((f, i) => tone('triangle', f, f, 0.22, 0.09, i * 0.06))],
    death:  [1,    () => [392, 330, 262, 196].forEach((f, i) => tone('triangle', f, f * 0.97, 0.3, 0.12, i * 0.18))],
    phase:  [0.5,  () => { tone('square', 220, 440, 0.25, 0.08); tone('square', 330, 660, 0.25, 0.06, 0.04); }],
  };

  let gemCombo = 0, gemT = 0;

  window.Sfx = {
    get enabled() { return enabled; },
    setEnabled(v) {
      enabled = v;
      try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* приватный режим */ }
      if (master) master.gain.value = v ? 0.7 : 0;
      if (v) unlock();
    },
    play(name) {
      if (!enabled || !ctx || ctx.state !== 'running' || voices > MAX_VOICES) return;
      const s = SOUNDS[name];
      const now = ctx.currentTime;
      if (now - (last[name] || -1) < s[0]) return;
      last[name] = now;
      if (name === 'gem') { gemCombo = now - gemT < 0.4 ? gemCombo + 1 : 0; gemT = now; }
      s[1](gemCombo);
    },
  };

  // ===================================================================
  // Музыка: спокойный генеративный чиптюн.
  // Бас — треугольник, арпеджио — мягкий pulse 25%, мелодия — треугольник
  // с эхом. Фраза из 4 тактов звучит дважды, затем новая; каждые 20 тактов
  // мелодия замолкает на 4 такта, чтобы музыка не надоедала.
  // ===================================================================
  const MUSIC_KEY = 'night-swarm-music';
  let musicOn = true;
  try { musicOn = localStorage.getItem(MUSIC_KEY) !== '0'; } catch (e) { /* приватный режим */ }

  // аккорды: [корень (MIDI, басовая октава), минор?]
  const MODES = {
    menu: { bpm: 68, chords: [[45, 1], [41, 0], [48, 0], [43, 0]], bass: [0, 4], arp: [0, 2, 3, 4, 6], hat: [], kick: [], lead: 0.8 },
    run:  { bpm: 80, chords: [[45, 1], [52, 1], [41, 0], [43, 0]], bass: [0, 3, 4, 6], arp: [0, 1, 2, 3, 4, 5, 6, 7], hat: [2, 6], kick: [], lead: 1 },
    boss: { bpm: 92, chords: [[45, 1], [41, 0], [50, 1], [52, 0]], bass: [0, 1, 2, 3, 4, 5, 6, 7], arp: [0, 1, 2, 3, 4, 5, 6, 7], hat: [1, 3, 5, 7], kick: [0, 4], lead: 0.9 },
  };
  const PENTA = [0, 3, 5, 7, 10];       // минорная пентатоника от A
  const ARP = [0, 1, 2, 3, 2, 1, 0, 2]; // индексы тонов аккорда (3 — октава корня)

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  let mBus = null, mOut = null, echo = null, pulse = null;
  let mode = 'menu', cur = MODES.menu, nextT = 0, step = 0, bar = 0, timer = 0;
  let phrase = null, ducked = false, fadeTo = 1;

  function buildBus() {
    mOut = ctx.createGain(); mOut.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    mBus = ctx.createGain(); mBus.gain.value = 1;
    mBus.connect(lp); lp.connect(mOut); mOut.connect(bus);
    // эхо для мелодии
    echo = ctx.createGain(); echo.gain.value = 1;
    const d = ctx.createDelay(1); d.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    echo.connect(mBus); echo.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(mBus);
    // pulse 25%: ряд Фурье, урезанный до 12 гармоник — звучит мягче
    const N = 13, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) re[n] = 2 / (n * Math.PI) * Math.sin(n * Math.PI * 0.25);
    pulse = ctx.createPeriodicWave(re, im);
  }

  function mnote(wave, freq, t, dur, vol, dest, attack) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    if (wave === 'pulse') o.setPeriodicWave(pulse); else o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    const a = attack || 0.008;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(vol * 0.5, t + a + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || mBus);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function mnoise(t, dur, vol, freq) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = 'highpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(mBus);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  /** Фраза на 4 такта: случайное блуждание по пентатонике, длинные ноты. */
  function makePhrase() {
    const out = [];
    let deg = 5 + ((Math.random() * 3) | 0);   // ступень в «растянутой» пентатонике
    for (let b = 0; b < 4; b++) {
      const notes = [];
      const slots = Math.random() < 0.5 ? [0, 3, 6] : [0, 4];
      for (const s of slots) {
        if (s && Math.random() < 0.25) continue;  // паузы — воздух
        deg += [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0];
        deg = Math.max(3, Math.min(11, deg));
        notes.push([s, deg]);
      }
      out.push(notes);
    }
    // последняя нота фразы — на тонику
    const last = out[3];
    if (last.length) last[last.length - 1][1] = 5;
    return out;
  }
  function degToMidi(d) { return 57 + Math.floor(d / 5) * 12 + PENTA[d % 5]; }

  function scheduleStep(t) {
    const m = cur, sd = 60 / m.bpm / 2;
    const [root, minor] = m.chords[bar % m.chords.length];
    const tones = [root, root + (minor ? 3 : 4), root + 7, root + 12];
    if (m.bass.indexOf(step) >= 0) {
      const len = m.bass.length > 4 ? 0.9 : step === 0 ? 3.5 : 1.6;
      mnote('triangle', mtof(root - (step % 2 && m.bass.length > 4 ? -12 : 0)), t, sd * len, 0.16);
    }
    if (m.arp.indexOf(step) >= 0) mnote('pulse', mtof(tones[ARP[step]] + 12), t, sd * 0.9, 0.032);
    if (m.hat.indexOf(step) >= 0) mnoise(t, 0.04, 0.012, 7000);
    if (m.kick.indexOf(step) >= 0) mnote('sine', 110, t, 0.12, 0.12);
    // мелодия: 8 тактов фраза A ×2, затем 4 такта отдыха
    const cycle = bar % 20;
    if (cycle < 16) {
      if (step === 0 && cycle % 8 === 0) phrase = makePhrase();
      if (phrase) for (const n of phrase[cycle % 4]) {
        if (n[0] === step) mnote('triangle', mtof(degToMidi(n[1])), t, sd * 2.6, 0.075 * m.lead, echo, 0.02);
      }
    }
  }

  function tick() {
    if (!ctx || ctx.state !== 'running' || !mBus) return;
    const now = ctx.currentTime;
    if (nextT < now - 0.1) nextT = now + 0.05;   // после фона — не догоняем пропущенное
    while (nextT < now + 0.25) {
      scheduleStep(nextT);
      nextT += 60 / cur.bpm / 2;
      if (++step >= 8) { step = 0; bar++; }
    }
  }
  function applyGain(time) {
    if (!mOut) return;
    const v = musicOn ? 0.4 * fadeTo * (ducked ? 0.45 : 1) : 0;
    mOut.gain.cancelScheduledValues(ctx.currentTime);
    mOut.gain.setTargetAtTime(v, ctx.currentTime, time || 0.4);
  }

  window.Music = {
    get enabled() { return musicOn; },
    setEnabled(v) {
      musicOn = v;
      try { localStorage.setItem(MUSIC_KEY, v ? '1' : '0'); } catch (e) { /* приватный режим */ }
      if (v) unlock();
      applyGain(0.2);
    },
    /** 'menu' | 'run' | 'boss'. Смена — мягкий перелив за ~1 с. */
    setMode(m) {
      if (m === mode) return;
      mode = m;
      if (!mOut) { cur = MODES[m]; return; }
      fadeTo = 0; applyGain(0.25);
      setTimeout(() => {
        cur = MODES[mode]; step = 0; bar = 0; phrase = null;
        nextT = ctx.currentTime + 0.1;
        fadeTo = 1; applyGain(0.8);
      }, 700);
    },
    /** Приглушить на паузе и экранах выбора. */
    duck(v) { if (v === ducked) return; ducked = v; applyGain(0.3); },
    _start() {
      if (mBus || !ctx) return;
      buildBus();
      cur = MODES[mode]; nextT = ctx.currentTime + 0.1;
      applyGain(1.5);
      timer = setInterval(tick, 60);
    },
  };
})();
