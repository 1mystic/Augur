// Subtle board sounds, synthesised with Web Audio (no audio files): a soft wooden tock for a move,
// a thud + clack + falling pop for a capture, a double tock for castling and a faint ping for check.
let ctx = null, noise = null;
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
/** One knock: a filtered noise click (the contact) over a short low sine (the body of the board). */
function knock(t, { freq = 1700, low = 190, gain = 0.16, len = 0.07 } = {}) {
  const c = ctx, out = c.createGain();
  out.gain.setValueAtTime(gain, t); out.gain.exponentialRampToValueAtTime(0.0001, t + len * 1.6);
  out.connect(c.destination);
  const n = c.createBufferSource(); n.buffer = noise;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4;
  const ng = c.createGain(); ng.gain.setValueAtTime(0.9, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.5);
  n.connect(bp).connect(ng).connect(out); n.start(t); n.stop(t + len);
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(low, t); o.frequency.exponentialRampToValueAtTime(low * 0.6, t + len);
  const og = c.createGain(); og.gain.setValueAtTime(0.7, t); og.gain.exponentialRampToValueAtTime(0.0001, t + len * 1.5);
  o.connect(og).connect(out); o.start(t); o.stop(t + len * 1.6);
}
function ping(t) {
  const c = ctx, o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = 1320;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.25);
}
/** Capture: a heavy thud as the piece lands, a bright clack of the two pieces meeting, and a short falling 'pop'. */
function capture(t) {
  knock(t, { freq: 900, low: 120, gain: 0.3, len: 0.11 });
  knock(t + 0.03, { freq: 2600, low: 420, gain: 0.13, len: 0.05 });
  const c = ctx, o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(560, t + 0.02); o.frequency.exponentialRampToValueAtTime(220, t + 0.16);
  g.gain.setValueAtTime(0.0001, t + 0.02); g.gain.exponentialRampToValueAtTime(0.07, t + 0.035); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  o.connect(g).connect(c.destination); o.start(t + 0.02); o.stop(t + 0.22);
}
/** Play the sound for a move, from its SAN. */
export function moveSound(san) {
  try {
    if (!ac()) return;
    const t = ctx.currentTime + 0.005;
    if (san.startsWith('O-O')) { knock(t); knock(t + 0.09, { freq: 1500, gain: 0.13 }); }
    else if (san.includes('x')) capture(t);
    else knock(t);
    if (/[+#]/.test(san)) ping(t + 0.06);
  } catch { /* audio is optional */ }
}
