/* Every sound here is synthesized at runtime with the Web Audio API, so the
   project ships no sampled audio. The message alert is a formant-filtered
   two-syllable tone - a homemade stand-in for a certain "uh-oh". */

(function (global) {
  'use strict';

  const STORAGE_KEY = 'openicq.sound';

  let ctx = null;
  let master = null;
  let enabled = localStorage.getItem(STORAGE_KEY) !== 'off';

  function audio() {
    if (!ctx) {
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** One vowel-ish syllable: a buzzy glottal source shaped by three formants. */
  function syllable(at, duration, pitchFrom, pitchTo, formants, level) {
    const source = ctx.createOscillator();
    source.type = 'sawtooth';
    source.frequency.setValueAtTime(pitchFrom, at);
    source.frequency.exponentialRampToValueAtTime(pitchTo, at + duration);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(level, at + 0.025);
    envelope.gain.setValueAtTime(level, at + duration * 0.6);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(envelope);

    formants.forEach(([freq, q, gain]) => {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = q;

      const trim = ctx.createGain();
      trim.gain.value = gain;

      envelope.connect(band);
      band.connect(trim);
      trim.connect(master);
    });

    source.start(at);
    source.stop(at + duration + 0.05);
  }

  function tone(at, duration, freqFrom, freqTo, type, level, filterHz) {
    const osc = ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freqFrom, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), at + duration);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(level, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(envelope);

    if (filterHz) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = filterHz;
      envelope.connect(lp);
      lp.connect(master);
    } else {
      envelope.connect(master);
    }

    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  function noise(at, duration, level, filterHz, type) {
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = type || 'lowpass';
    filter.frequency.value = filterHz;

    const envelope = ctx.createGain();
    envelope.gain.value = level;

    src.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    src.start(at);
  }

  // Formant recipes, roughly: [frequency, Q, output gain]
  const VOWEL_UH = [
    [640, 9, 0.9],
    [1190, 11, 0.5],
    [2390, 13, 0.18],
  ];
  const VOWEL_OH = [
    [450, 10, 1.0],
    [820, 12, 0.42],
    [2550, 14, 0.12],
  ];

  const EFFECTS = {
    /** "Uh-oh!" - incoming message. */
    message() {
      const t = ctx.currentTime + 0.02;
      syllable(t, 0.16, 232, 205, VOWEL_UH, 0.5);
      syllable(t + 0.2, 0.3, 196, 150, VOWEL_OH, 0.55);
    },

    /** A contact signed on: door swinging open. */
    online() {
      const t = ctx.currentTime + 0.02;
      noise(t, 0.26, 0.1, 1400);
      tone(t, 0.3, 190, 420, 'sine', 0.1, 2200);
      tone(t + 0.26, 0.1, 900, 900, 'square', 0.035, 1800);
    },

    /** A contact signed off: door pulled shut. */
    offline() {
      const t = ctx.currentTime + 0.02;
      tone(t, 0.26, 420, 150, 'sine', 0.1, 1600);
      noise(t + 0.2, 0.14, 0.18, 700);
      tone(t + 0.22, 0.16, 120, 60, 'sine', 0.16, 500);
    },

    sent() {
      const t = ctx.currentTime + 0.01;
      tone(t, 0.07, 1180, 1500, 'square', 0.045, 4000);
    },

    auth() {
      const t = ctx.currentTime + 0.02;
      tone(t, 0.16, 880, 880, 'triangle', 0.14, 5000);
      tone(t + 0.14, 0.26, 1320, 1320, 'triangle', 0.12, 5000);
    },

    error() {
      const t = ctx.currentTime + 0.02;
      tone(t, 0.18, 180, 150, 'square', 0.09, 900);
      tone(t + 0.2, 0.22, 140, 110, 'square', 0.09, 900);
    },

    signon() {
      const t = ctx.currentTime + 0.02;
      [523.25, 659.25, 783.99].forEach((f, i) => {
        tone(t + i * 0.08, 0.22, f, f, 'triangle', 0.09, 6000);
      });
    },
  };

  function play(name) {
    if (!enabled) return;
    const effect = EFFECTS[name];
    if (!effect || !audio()) return;
    try {
      effect();
    } catch {
      /* audio is a nicety, never break the client over it */
    }
  }

  function setEnabled(value) {
    enabled = !!value;
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    if (enabled) play('sent');
  }

  // Browsers keep audio suspended until the user interacts with the page.
  ['pointerdown', 'keydown'].forEach((evt) =>
    global.addEventListener(evt, () => audio(), { once: true, passive: true })
  );

  global.Sounds = {
    play,
    setEnabled,
    isEnabled: () => enabled,
  };
})(window);
