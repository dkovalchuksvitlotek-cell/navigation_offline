// Озвучування інструкцій, голосові команди та кнопки гарнітури/керма.

export class Voice {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.voice = null;
    this.rate = 1;
    if (this.synth) {
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  pickVoice() {
    const voices = this.synth.getVoices();
    this.voice =
      voices.find((v) => v.lang === 'uk-UA' && v.localService) ||
      voices.find((v) => v.lang?.toLowerCase().startsWith('uk')) ||
      null;
  }

  get available() {
    return !!this.synth;
  }

  get hasUkrainian() {
    return !!this.voice;
  }

  speak(text) {
    if (!this.synth) return;
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'uk-UA';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    this.synth.speak(u);
  }

  stop() {
    this.synth?.cancel();
  }
}

/**
 * Голосові команди «готово», «повтори», «назад».
 * Розпізнавання мовлення в браузерах часто потребує інтернету, тому це лише додаткова можливість.
 */
export class Commands {
  constructor(handlers) {
    this.handlers = handlers;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    if (!SR) return;
    this.rec = new SR();
    this.rec.lang = 'uk-UA';
    this.rec.continuous = true;
    this.rec.interimResults = false;
    this.rec.onresult = (e) => {
      const said = e.results[e.results.length - 1][0].transcript.toLowerCase();
      if (/готово|виконано|далі|зроблено/.test(said)) this.handlers.done();
      else if (/повтор/.test(said)) this.handlers.repeat();
      else if (/назад|попередн/.test(said)) this.handlers.back();
      else if (/пропуст|проїхав|проґав|прогав/.test(said)) this.handlers.missed();
    };
    this.rec.onend = () => { if (this.active) this.safeStart(); };
    this.rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
        this.active = false;
        this.handlers.error?.(e.error);
      }
    };
  }

  safeStart() {
    try { this.rec.start(); } catch { /* вже запущено */ }
  }

  start() {
    if (!this.supported) return false;
    this.active = true;
    this.safeStart();
    return true;
  }

  stop() {
    this.active = false;
    this.rec?.stop();
  }
}

/**
 * Кнопки «наступний/попередній трек» на Bluetooth-гарнітурі чи кермі.
 * Браузер передає їх сторінці лише під час відтворення медіа, тому граємо тишу в циклі.
 */
export class MediaButtons {
  constructor(handlers) {
    this.handlers = handlers;
    this.supported = 'mediaSession' in navigator;
  }

  async start() {
    if (!this.supported) return false;
    if (!this.audio) {
      this.audio = new Audio(URL.createObjectURL(silentWav(2)));
      this.audio.loop = true;
      this.audio.volume = 0.01;
    }
    await this.audio.play();
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: 'Навігація без GPS', artist: 'Наступний трек = «Виконано»' });
    ms.setActionHandler('nexttrack', () => this.handlers.done());
    ms.setActionHandler('previoustrack', () => this.handlers.back());
    ms.setActionHandler('play', () => { this.audio.play(); this.handlers.repeat(); });
    ms.setActionHandler('pause', () => { this.audio.play(); this.handlers.repeat(); });
    return true;
  }

  stop() {
    this.audio?.pause();
    if (this.supported) {
      for (const a of ['nexttrack', 'previoustrack', 'play', 'pause']) {
        navigator.mediaSession.setActionHandler(a, null);
      }
    }
  }
}

function silentWav(seconds, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return new Blob([buf], { type: 'audio/wav' });
}
