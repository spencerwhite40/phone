// Everything greeting-related happens here: record from the mic, or take any
// audio file the browser can decode, and turn it into a small mono 16 kHz WAV
// (the one format every phone carrier path plays without surprises).
export const MAX_SECONDS = 120;
const OUT_RATE = 16000;

function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // box-average over the source window: cheap anti-aliasing when downsampling
    const a = Math.floor(i * ratio);
    const b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return out;
}

export function encodeWav(samples, sampleRate) {
  const pcm = resample(samples, sampleRate, OUT_RATE);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, OUT_RATE, true); v.setUint32(28, OUT_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { blob: new Blob([buf], { type: 'audio/wav' }), seconds: Math.round(pcm.length / OUT_RATE) };
}

// Decode any uploaded audio (mp3, m4a, wav, ogg, ...) and convert it.
export async function fileToWav(file) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    if (audio.duration > MAX_SECONDS) throw new Error(`That file is ${Math.round(audio.duration)}s. Greetings can be up to ${MAX_SECONDS}s.`);
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    return encodeWav(mono, audio.sampleRate);
  } catch (e) {
    if (e instanceof DOMException || /decode/i.test(e.message)) throw new Error("This browser couldn't read that audio file. Try an MP3 or WAV.");
    throw e;
  } finally { ctx.close().catch(() => {}); }
}

// Start a mic recording. Call from a click so iOS lets the AudioContext run.
export async function startRecording(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let total = 0;
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d); total += d.length;
    if (onLevel) { let m = 0; for (let i = 0; i < d.length; i += 16) m = Math.max(m, Math.abs(d[i])); onLevel(m, total / ctx.sampleRate); }
  };
  const mute = ctx.createGain(); mute.gain.value = 0; // keep the graph alive without echoing the mic
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const teardown = () => {
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {});
  };
  return {
    stop() {
      const rate = ctx.sampleRate; teardown();
      const all = new Float32Array(total); let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      return encodeWav(all, rate);
    },
    cancel: teardown,
  };
}
