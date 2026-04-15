/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Activity, 
  Settings, 
  Power, 
  Volume2, 
  Mic, 
  MicOff, 
  Zap, 
  Music, 
  Waves, 
  Clock, 
  Wind,
  SlidersHorizontal,
  ChevronRight,
  AlertCircle,
  HelpCircle
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// Waveshaper curves
// ─────────────────────────────────────────────────────────────
function makeOverdriveCurve(amount: number) {
  const n = 256, curve = new Float32Array(n);
  const k = amount === 1 ? 9999 : (2 * amount) / (1 - amount);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}
function makeDistortionCurve(amount: number) {
  const n = 256, curve = new Float32Array(n);
  const thr = 1 - amount * 0.9;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.max(-thr, Math.min(thr, x / thr));
  }
  return curve;
}
function makeFuzzCurve(amount: number) {
  const n = 256, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * (50 + amount * 200)) * (0.6 + amount * 0.4);
  }
  return curve;
}
function buildReverbIR(ctx: AudioContext, roomSize: number, damping: number) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (0.5 + roomSize * 3.5));
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * (1 + damping * 6));
    }
  }
  return ir;
}

// ─────────────────────────────────────────────────────────────
// Chromatic Tuner Logic
// ─────────────────────────────────────────────────────────────
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function getNoteFromFrequency(freq: number) {
  if (freq < 20) return { note: "-", cents: 0 };
  const noteNum = 12 * (Math.log(freq / 440) / Math.log(2));
  const rounded = Math.round(noteNum);
  const note = NOTES[(rounded + 69) % 12];
  const cents = Math.floor(100 * (noteNum - rounded));
  return { note, cents };
}

// ─────────────────────────────────────────────────────────────
// Audio Engine hook
// ─────────────────────────────────────────────────────────────
function useAudioEngine() {
  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "error">("idle");
  const [inputLevel, setInputLevel] = useState(0);
  const [tuning, setTuning] = useState({ note: "-", cents: 0 });
  const [isExternal, setIsExternal] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const refs = useRef<any>({});

  const apply = useCallback((params: any) => {
    const r = refs.current;
    if (!r.ctx) return;
    const now = r.ctx.currentTime;
    const set = (node: any, param: string, val: number) => node[param].setTargetAtTime(val, now, 0.01);

    if (params.noiseGate !== undefined) {
      set(r.gateGain, "gain", params.noiseGate ? 1 : 1);
      set(r.compressor, "threshold", params.noiseGate ? (params.threshold ?? -40) : 0);
    }
    if (params.compressor) {
      const c = params.compressor;
      if (c.enabled !== undefined) {
        set(r.compressor, "threshold", c.enabled ? (c.threshold ?? -24) : 0);
        set(r.compressor, "ratio", c.enabled ? (c.ratio ?? 4) : 1);
      }
    }
    if (params.eq) {
      const e = params.eq;
      if (e.low !== undefined)  { r.eqLow.frequency.value = e.lowFreq ?? 200;  set(r.eqLow,  "gain", e.enabled ? e.low  : 0); }
      if (e.mid !== undefined)  { r.eqMid.frequency.value = e.midFreq ?? 1000; set(r.eqMid,  "gain", e.enabled ? e.mid  : 0); }
      if (e.high !== undefined) { r.eqHigh.frequency.value= e.highFreq?? 4000; set(r.eqHigh, "gain", e.enabled ? e.high : 0); }
    }
    if (params.drive) {
      const d = params.drive;
      const pre = d.enabled ? 1 + d.gain * 150 : 0;
      set(r.drivePre, "gain", pre);
      set(r.dryGain, "gain", d.enabled ? 0 : 1);
      set(r.drivePost, "gain", d.level * 0.5);
      r.driveTone.frequency.value = 500 + d.tone * 8000;
      if (d.enabled) {
        r.driveShaper.curve =
          d.mode === "overdrive"   ? makeOverdriveCurve(d.gain)  :
          d.mode === "distortion"  ? makeDistortionCurve(d.gain) :
          makeFuzzCurve(d.gain);
      } else {
        r.driveShaper.curve = null;
      }
    }
    if (params.mod) {
      const m = params.mod;
      r.modShape = m.shape ?? "sine";
      
      if (m.shape === "random") {
        r.modLFOGain.disconnect();
      } else {
        try { r.modLFOGain.connect(r.modDelay.delayTime); } catch(e) {}
        r.modLFO.type = m.shape ?? "sine";
        r.modLFO.frequency.value = m.rate ?? 1.5;
      }
      
      if (m.mode === "tremolo") {
        set(r.modLFOGain, "gain", m.enabled ? (m.depth ?? 0.5) * 0.5 : 0);
        set(r.modWet, "gain", m.enabled ? (m.mix ?? 0.5) : 0);
        set(r.modFB, "gain", 0);
        r.modDelay.delayTime.value = 0;
      } else {
        set(r.modLFOGain, "gain", m.enabled ? (m.depth ?? 0.5) * 0.008 : 0);
        set(r.modWet, "gain", m.enabled ? (m.mix ?? 0.5) : 0);
        set(r.modFB, "gain", m.enabled && m.mode === "flanger" ? 0.5 : 0);
        if (m.shape !== "random") {
          r.modDelay.delayTime.value = m.mode === "flanger" ? 0.005 : 0.02;
        }
      }
    }
    if (params.delay) {
      const d = params.delay;
      r.delayNode.delayTime.value = d.time ?? 0.4;
      set(r.delayFB, "gain", d.enabled ? Math.min(d.feedback ?? 0.4, 0.95) : 0);
      set(r.delayWet, "gain", d.enabled ? (d.mix ?? 0.35) : 0);
      set(r.delayDry, "gain", 1);
    }
    if (params.amp) {
      const a = params.amp;
      r.ampNode.frequency.value = 2000 + a.tone * 8000;
      set(r.ampGain, "gain", a.enabled ? a.gain : 1);
      set(r.ampLevel, "gain", a.enabled ? a.level : 0);
    }
    if (params.reverb) {
      const rv = params.reverb;
      if (rv.enabled) {
        r.reverbConv.buffer = buildReverbIR(r.ctx, rv.roomSize ?? 0.5, rv.damping ?? 0.5);
      }
      set(r.reverbWet, "gain", rv.enabled ? (rv.mix ?? 0.3) : 0);
      set(r.reverbDry, "gain", 1);
    }
    if (params.master !== undefined) {
      set(r.masterGain, "gain", params.mute ? 0 : params.master);
    }
  }, []);

  const start = useCallback(async () => {
    try {
      setStatus("connecting");

      // Proactive permission check
      if (navigator.permissions && (navigator.permissions as any).query) {
        try {
          const result = await (navigator.permissions as any).query({ name: 'microphone' });
          if (result.state === 'denied') {
            setErrorMessage("Microphone access is blocked in your browser settings. Please click the icon in your address bar to allow access.");
            setStatus("error");
            return;
          }
        } catch (e) {
          // Ignore if permission query is not supported for microphone
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false },
        }
      });
      setIsExternal(false);

      const ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);

      // Build chain
      const inputGain    = ctx.createGain();
      const gateGain     = ctx.createGain();
      const compressor   = ctx.createDynamicsCompressor();
      const eqLow        = Object.assign(ctx.createBiquadFilter(), { type: "lowshelf" as const });
      const eqMid        = Object.assign(ctx.createBiquadFilter(), { type: "peaking" as const });
      const eqHigh       = Object.assign(ctx.createBiquadFilter(), { type: "highshelf" as const });
      const drivePre     = ctx.createGain();
      const driveShaper  = Object.assign(ctx.createWaveShaper(), { oversample: "4x" as const });
      const driveTone    = Object.assign(ctx.createBiquadFilter(), { type: "lowpass" as const });
      const drivePost    = ctx.createGain();
      const ampNode      = Object.assign(ctx.createBiquadFilter(), { type: "lowpass" as const });
      const ampGain      = ctx.createGain();
      const ampLevel     = ctx.createGain();
      const dryGain      = ctx.createGain();
      const modDelay     = ctx.createDelay(0.05);
      const modLFO       = ctx.createOscillator();
      const modLFOGain   = ctx.createGain();
      const modWet       = ctx.createGain();
      const modFB        = ctx.createGain();
      const delayNode    = ctx.createDelay(2.0);
      const delayFB      = ctx.createGain();
      const delayWet     = ctx.createGain();
      const delayDry     = ctx.createGain();
      const reverbConv   = ctx.createConvolver();
      const reverbWet    = ctx.createGain();
      const reverbDry    = ctx.createGain();
      const masterGain   = ctx.createGain();
      const analyser     = ctx.createAnalyser();

      modLFO.type = "sine"; modLFO.start();
      analyser.fftSize = 256;

      // Connect
      source.connect(inputGain);
      source.connect(analyser);
      inputGain.connect(gateGain);
      gateGain.connect(compressor);
      compressor.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
      eqHigh.connect(drivePre); eqHigh.connect(dryGain);
      drivePre.connect(driveShaper); driveShaper.connect(driveTone);
      driveTone.connect(drivePost);
      drivePost.connect(ampNode);
      ampNode.connect(ampGain);
      ampGain.connect(ampLevel);
      ampLevel.connect(modDelay); dryGain.connect(modDelay);
      modLFO.connect(modLFOGain); modLFOGain.connect(modDelay.delayTime);
      modDelay.connect(modFB); modFB.connect(modDelay);
      modDelay.connect(modWet); modWet.connect(delayNode);
      drivePost.connect(delayDry); dryGain.connect(delayDry);
      delayNode.connect(delayFB); delayFB.connect(delayNode);
      delayNode.connect(delayWet);
      delayDry.connect(reverbDry); delayWet.connect(reverbDry);
      reverbDry.connect(reverbConv); reverbConv.connect(reverbWet);
      reverbDry.connect(masterGain); reverbWet.connect(masterGain);
      masterGain.connect(ctx.destination);

      refs.current = {
        ctx, stream, analyser,
        gateGain, compressor, eqLow, eqMid, eqHigh,
        drivePre, driveShaper, driveTone, drivePost, ampNode, ampGain, ampLevel, dryGain,
        modLFO, modLFOGain, modWet, modFB, modDelay,
        delayNode, delayFB, delayWet, delayDry,
        reverbConv, reverbWet, reverbDry, masterGain,
        gateOpen: false, gateTimer: 0,
        modShape: "sine",
      };

      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!refs.current.ctx) return;
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        setInputLevel(Math.min(rms * 6, 1));
        
        let maxCorr = 0, bestLag = -1;
        for (let lag = 50; lag < 500; lag++) {
          let corr = 0;
          for (let i = 0; i < analyser.fftSize - lag; i++) corr += buf[i] * buf[i + lag];
          if (corr > maxCorr) { maxCorr = corr; bestLag = lag; }
        }
        if (rms > 0.05 && bestLag > 0) {
          setTuning(getNoteFromFrequency(44100 / bestLag));
        } else {
          setTuning({ note: "-", cents: 0 });
        }
        
        if (refs.current.modShape === "random") {
          refs.current.modDelay.delayTime.setTargetAtTime(Math.random() * 0.02, refs.current.ctx.currentTime, 0.05);
        }
        requestAnimationFrame(tick);
      };
      tick();
      setStatus("active");
    } catch (e: any) {
      console.error(e);
      let msg = "An unexpected error occurred.";
      if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        msg = "Microphone not found. Please ensure your microphone is connected and permissions are granted.";
      } else if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        msg = "Microphone permission denied. Please allow microphone access in your browser settings.";
      }
      setErrorMessage(msg);
      setStatus("error");
    }
  }, [apply, setIsExternal, setStatus]);

  const stop = useCallback(() => {
    const r = refs.current;
    if (r.ctx) { r.modLFO?.stop(); r.ctx.close(); }
    r.stream?.getTracks().forEach((t: any) => t.stop());
    refs.current = {};
    setStatus("idle");
    setErrorMessage(null);
    setInputLevel(0);
    setTuning({ note: "-", cents: 0 });
  }, []);

  useEffect(() => () => stop(), [stop]);
  return { status, setStatus, errorMessage, setErrorMessage, inputLevel, tuning, isExternal, setIsExternal, start, stop, apply };
}

// ─────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────
const PRESETS: Record<string, any> = {
  Clean:    { drive: { enabled: false, gain: 0,   tone: 0.5, level: 0.8, mode: "overdrive" }, mod: { enabled: false, rate: 1.5, depth: 0.3, mix: 0.3, mode: "chorus" }, delay: { enabled: false, time: 0.4, feedback: 0.3, mix: 0.3 }, reverb: { enabled: true,  roomSize: 0.3, damping: 0.5, mix: 0.2 }, eq: { enabled: true, low: 2,  mid: 0,  high: 1,  lowFreq: 200, midFreq: 1000, highFreq: 4000 } },
  Blues:    { drive: { enabled: true,  gain: 0.3, tone: 0.65,level: 0.75,mode: "overdrive" }, mod: { enabled: false, rate: 1.2, depth: 0.3, mix: 0.3, mode: "chorus" }, delay: { enabled: true,  time: 0.35,feedback: 0.25,mix: 0.2 }, reverb: { enabled: true,  roomSize: 0.4, damping: 0.6, mix: 0.25}, eq: { enabled: true, low: 3,  mid: 2,  high: -1, lowFreq: 200, midFreq: 800,  highFreq: 4000 } },
  Rock:     { drive: { enabled: true,  gain: 0.6, tone: 0.7, level: 0.7, mode: "overdrive" }, mod: { enabled: false, rate: 1.5, depth: 0.3, mix: 0.3, mode: "chorus" }, delay: { enabled: true,  time: 0.3, feedback: 0.3, mix: 0.25}, reverb: { enabled: true,  roomSize: 0.5, damping: 0.5, mix: 0.3 }, eq: { enabled: true, low: 4,  mid: -2, high: 3,  lowFreq: 100, midFreq: 800,  highFreq: 5000 } },
  Metal:    { drive: { enabled: true,  gain: 0.9, tone: 0.8, level: 0.65,mode: "distortion"},mod: { enabled: false, rate: 1,   depth: 0.2, mix: 0.2, mode: "chorus" }, delay: { enabled: false, time: 0.2, feedback: 0.2, mix: 0.15}, reverb: { enabled: true,  roomSize: 0.3, damping: 0.8, mix: 0.15}, eq: { enabled: true, low: 6,  mid: -4, high: 5,  lowFreq: 80,  midFreq: 600,  highFreq: 6000 } },
  Jazz:     { drive: { enabled: false, gain: 0.1, tone: 0.4, level: 0.8, mode: "overdrive" }, mod: { enabled: true,  rate: 0.8, depth: 0.3, mix: 0.35,mode: "chorus" }, delay: { enabled: false, time: 0.5, feedback: 0.2, mix: 0.15}, reverb: { enabled: true,  roomSize: 0.6, damping: 0.4, mix: 0.35}, eq: { enabled: true, low: 2,  mid: 1,  high: -3, lowFreq: 250, midFreq: 1200, highFreq: 3500 } },
  Shoegaze: { drive: { enabled: true,  gain: 0.7, tone: 0.5, level: 0.6, mode: "fuzz"     }, mod: { enabled: true,  rate: 0.5, depth: 0.8, mix: 0.7, mode: "chorus" }, delay: { enabled: true,  time: 0.6, feedback: 0.7, mix: 0.5 }, reverb: { enabled: true,  roomSize: 0.9, damping: 0.3, mix: 0.6 }, eq: { enabled: true, low: -2, mid: -3, high: 2,  lowFreq: 200, midFreq: 1000, highFreq: 4500 } },
  Bedroom:  { drive: { enabled: false, gain: 0.2, tone: 0.5, level: 0.5, mode: "overdrive" }, mod: { enabled: true,  rate: 2,   depth: 0.4, mix: 0.4, mode: "tremolo"}, delay: { enabled: true,  time: 0.5, feedback: 0.4, mix: 0.3 }, reverb: { enabled: true,  roomSize: 0.7, damping: 0.5, mix: 0.45}, eq: { enabled: true, low: 1,  mid: 0,  high: -2, lowFreq: 200, midFreq: 1000, highFreq: 4000 } },
  Funk:     { drive: { enabled: false, gain: 0, tone: 0.5, level: 0.8, mode: "overdrive" }, mod: { enabled: true, rate: 6, depth: 0.5, mix: 0.4, mode: "tremolo" }, delay: { enabled: false, time: 0.3, feedback: 0.2, mix: 0.2 }, reverb: { enabled: true, roomSize: 0.2, damping: 0.6, mix: 0.15 }, eq: { enabled: true, low: 2, mid: 1, high: 2, lowFreq: 200, midFreq: 1000, highFreq: 4000 } },
  Ambient:  { drive: { enabled: false, gain: 0, tone: 0.5, level: 0.8, mode: "overdrive" }, mod: { enabled: true, rate: 0.3, depth: 0.5, mix: 0.4, mode: "chorus" }, delay: { enabled: true, time: 0.8, feedback: 0.6, mix: 0.5 }, reverb: { enabled: true, roomSize: 0.9, damping: 0.2, mix: 0.8 }, eq: { enabled: true, low: 1, mid: 0, high: 2, lowFreq: 200, midFreq: 1000, highFreq: 4000 } },
  Grunge:   { drive: { enabled: true, gain: 0.7, tone: 0.4, level: 0.7, mode: "distortion" }, mod: { enabled: true, rate: 0.5, depth: 0.2, mix: 0.2, mode: "chorus" }, delay: { enabled: false, time: 0.3, feedback: 0.2, mix: 0.2 }, reverb: { enabled: true, roomSize: 0.4, damping: 0.5, mix: 0.2 }, eq: { enabled: true, low: 3, mid: 2, high: 1, lowFreq: 150, midFreq: 700, highFreq: 4000 } },
  Surf:     { drive: { enabled: false, gain: 0, tone: 0.6, level: 0.8, mode: "overdrive" }, mod: { enabled: false, rate: 1, depth: 0.2, mix: 0.2, mode: "chorus" }, delay: { enabled: true, time: 0.15, feedback: 0.3, mix: 0.4 }, reverb: { enabled: true, roomSize: 0.8, damping: 0.4, mix: 0.6 }, eq: { enabled: true, low: 1, mid: 0, high: 3, lowFreq: 200, midFreq: 1000, highFreq: 5000 } },
};

// ─────────────────────────────────────────────────────────────
// UI Components
// ─────────────────────────────────────────────────────────────

function Knob({ value, onChange, size = 36, color = "#ff6600" }: { value: number, onChange: (v: number) => void, size?: number, color?: string }) {
  const angle = -135 + value * 270;
  const dragging = useRef(false);
  const startY = useRef(0);
  const startV = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startV.current = value;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = (startY.current - e.clientY) / 150;
    onChange(Math.max(0, Math.min(1, startV.current + delta)));
  };
  const onPointerUp = () => { dragging.current = false; };

  const cx = size / 2, cy = size / 2, r = size / 2 - 3;
  const rad = (angle - 90) * Math.PI / 180;
  const ix = cx + (r - 6) * Math.cos(rad);
  const iy = cy + (r - 6) * Math.sin(rad);
  const ox = cx + (r - 1) * Math.cos(rad);
  const oy = cy + (r - 1) * Math.sin(rad);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="cursor-ns-resize select-none touch-none"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <circle cx={cx} cy={cy} r={r} fill="#111" stroke="#333" strokeWidth="1.5"/>
        <circle cx={cx} cy={cy} r={r - 5} fill="#1a1a1a" stroke="#222" strokeWidth="0.5"/>
        <line x1={ix || 0} y1={iy || 0} x2={ox || 0} y2={oy || 0} stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
        <circle cx={cx} cy={cy} r={2} fill={color} className="opacity-40"/>
      </svg>
    </div>
  );
}

function LED({ on, color = "#ff2200" }: { on: boolean, color?: string }) {
  return (
    <motion.div 
      initial={false}
      animate={{ 
        backgroundColor: on ? color : "#200",
        boxShadow: on ? `0 0 8px ${color}, 0 0 16px ${color}44` : "none"
      }}
      className="w-2.5 h-2.5 rounded-full transition-all duration-150"
    />
  );
}

function Toggle({ on, onChange }: { on: boolean, onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!on)} className={`
      w-10 h-5 rounded-full border border-zinc-700 relative cursor-pointer transition-colors duration-200
      ${on ? "bg-orange-600 shadow-[0_0_12px_rgba(234,88,12,0.4)]" : "bg-zinc-900"}
    `}>
      <motion.div 
        animate={{ left: on ? 22 : 2 }}
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-colors duration-200 ${on ? "bg-white" : "bg-zinc-600"}`}
      />
    </div>
  );
}

function Slider({ value, onChange, color = "#ff6600" }: { value: number, onChange: (v: number) => void, color?: string }) {
  return (
    <div className="relative flex items-center w-full">
      <input type="range" min={0} max={100} value={Math.round(value * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-600"
        style={{ accentColor: color }}
      />
    </div>
  );
}

function EffectPanel({ title, color, enabled, onToggle, children, icon: Icon }: any) {
  return (
    <motion.div 
      layout
      className={`
        relative overflow-hidden rounded-lg border p-2.5 transition-all duration-300
        ${enabled ? "bg-zinc-900/80 border-zinc-700 shadow-lg bg-gradient-to-br from-zinc-800/50 to-zinc-900/50" : "bg-zinc-950 border-zinc-900 opacity-60"}
      `}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <LED on={enabled} color={color}/>
          <div className="flex flex-col">
            <span className={`text-[8px] font-mono font-bold tracking-wider ${enabled ? "text-white" : "text-zinc-600"}`}>
              {title}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {Icon && <Icon size={12} className={enabled ? "text-zinc-400" : "text-zinc-700"} />}
          <Toggle on={enabled} onChange={onToggle}/>
        </div>
      </div>
      <div className={`transition-all duration-300 ${enabled ? "opacity-100 scale-100" : "opacity-40 scale-95 pointer-events-none"}`}>
        {children}
      </div>
    </motion.div>
  );
}

function KnobRow({ items }: { items: any[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 justify-items-center">
      {items.map(({ label, value, onChange, color }) => (
        <div key={label} className="flex flex-col items-center gap-1">
          <Knob value={value} onChange={onChange} color={color || "#ea580c"}/>
          <span className="text-[7px] text-zinc-500 font-mono uppercase tracking-widest text-center leading-tight">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// VU Meter
// ─────────────────────────────────────────────────────────────
function VUMeter({ level }: { level: number }) {
  const bars = 20;
  return (
    <div className="flex gap-0.5 items-end h-8">
      {Array.from({ length: bars }).map((_, i) => {
        const lit = i < Math.round(level * bars);
        const isRed = i > bars * 0.85;
        const isYel = i > bars * 0.65;
        return (
          <motion.div 
            key={i} 
            animate={{ 
              backgroundColor: lit 
                ? isRed ? "#ef4444" : isYel ? "#f59e0b" : "#10b981"
                : "#18181b",
              boxShadow: lit ? `0 0 4px ${isRed ? "#ef4444" : isYel ? "#f59e0b" : "#10b981"}` : "none"
            }}
            className="w-1.5 rounded-t-sm"
            style={{ height: `${30 + i * 3.5}%` }}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tuner Component
// ─────────────────────────────────────────────────────────────
function Tuner({ note, cents }: { note: string, cents: number }) {
  return (
    <div className="flex flex-col items-center gap-2 p-3 bg-zinc-900 rounded-lg border border-zinc-800">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Tuner</div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-black text-white">{note}</span>
        <span className="text-xs font-mono text-zinc-400">{cents > 0 ? `+${cents}` : cents}¢</span>
      </div>
      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden flex">
        <div className="flex-1 bg-zinc-700" />
        <motion.div 
          animate={{ x: `${cents}%` }}
          className="w-1 h-full bg-orange-500"
        />
        <div className="flex-1 bg-zinc-700" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────
const DRIVE_MODES = ["overdrive", "distortion", "fuzz"];
const MOD_MODES   = ["chorus", "flanger", "phaser", "tremolo"];
const LFO_SHAPES  = ["sine", "triangle", "square", "sawtooth", "random"];

export default function App() {
  const { status, setStatus, errorMessage, setErrorMessage, inputLevel, tuning, isExternal, setIsExternal, start, stop, apply } = useAudioEngine();
  const [volume, setVolume] = useState(0.8);
  const [activeTab, setActiveTab] = useState("Dynamics");
  const tabs = ["Dynamics", "Tone", "Modulation", "Space"];
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [showTuner, setShowTuner] = useState(false);
  const [customPresets, setCustomPresets] = useState<Record<string, any>>({});
  const [newPresetName, setNewPresetName] = useState("");

  const savePreset = () => {
    if (!newPresetName) return;
    const currentConfig = { gate, comp, eq, drive, mod, delay, reverb, amp };
    setCustomPresets(prev => ({ ...prev, [newPresetName]: currentConfig }));
    setNewPresetName("");
  };

  const loadPreset = (name: string, config: any) => {
    setGate(config.gate);
    setComp(config.comp);
    setEq(config.eq);
    setDrive(config.drive);
    setMod(config.mod);
    setDelay(config.delay);
    setReverb(config.reverb);
    setAmp(config.amp);
    setActivePreset(name);
    apply(config);
  };

  const renderEffects = () => {
    switch (activeTab) {
      case "Dynamics":
        return (
          <>
            {/* Noise Gate */}
            <EffectPanel title="Noise Gate" color="#71717a" enabled={gate?.enabled} icon={Wind}
              onToggle={(v: boolean) => { setGate(g => ({ ...g, enabled: v })); apply({ noiseGate: v, threshold: gate.threshold }); }}>
              <KnobRow items={[
                { label: "Threshold", value: gate?.threshold * 20, color: "#71717a",
                  onChange: (v: number) => { setGate(g => ({ ...g, threshold: v / 20 })); } },
              ]}/>
            </EffectPanel>
            {/* Compressor */}
            <EffectPanel title="Compressor" color="#3b82f6" enabled={comp?.enabled} icon={Activity}
              onToggle={(v: boolean) => { setComp(c => ({ ...c, enabled: v })); apply({ compressor: { ...comp, enabled: v } }); }}>
              <KnobRow items={[
                { label: "Thresh", value: (comp?.threshold + 60) / 60, color: "#3b82f6",
                  onChange: (v: number) => { const t = v * 60 - 60; setComp(c => ({ ...c, threshold: t })); apply({ compressor: { ...comp, threshold: t } }); } },
                { label: "Ratio",  value: (comp?.ratio - 1) / 19,    color: "#3b82f6",
                  onChange: (v: number) => { const r = 1 + v * 19; setComp(c => ({ ...c, ratio: r })); apply({ compressor: { ...comp, ratio: r } }); } },
              ]}/>
            </EffectPanel>
          </>
        );
      case "Tone":
        return (
          <>
            {/* Amp */}
            <EffectPanel title="Amp Sim" color="#f59e0b" enabled={amp?.enabled} icon={Music}
              onToggle={(v: boolean) => setAmp(a => ({ ...a, enabled: v }))}>
              <KnobRow items={[
                { label: "Gain",  value: amp?.gain,  color: "#f59e0b", onChange: (v: number) => setAmp(a => ({ ...a, gain: v })) },
                { label: "Tone",  value: amp?.tone,  color: "#fbbf24", onChange: (v: number) => setAmp(a => ({ ...a, tone: v })) },
                { label: "Level", value: amp?.level, color: "#f59e0b", onChange: (v: number) => setAmp(a => ({ ...a, level: v })) },
              ]}/>
            </EffectPanel>
            {/* EQ */}
            <EffectPanel title="Tone EQ" color="#10b981" enabled={eq?.enabled} icon={SlidersHorizontal}
              onToggle={(v: boolean) => { setEq(e => ({ ...e, enabled: v })); apply({ eq: { ...eq, enabled: v } }); }}>
              <KnobRow items={[
                { label: "Low",  value: (eq?.low  + 15) / 30, color: "#10b981",
                  onChange: (v: number) => { const g = v * 30 - 15; setEq(e => ({ ...e, low: g }));  apply({ eq: { ...eq, low: g } }); } },
                { label: "Mid",  value: (eq?.mid  + 15) / 30, color: "#10b981",
                  onChange: (v: number) => { const g = v * 30 - 15; setEq(e => ({ ...e, mid: g }));  apply({ eq: { ...eq, mid: g } }); } },
                { label: "High", value: (eq?.high + 15) / 30, color: "#10b981",
                  onChange: (v: number) => { const g = v * 30 - 15; setEq(e => ({ ...e, high: g })); apply({ eq: { ...eq, high: g } }); } },
              ]}/>
            </EffectPanel>
            {/* Drive */}
            <EffectPanel title="Overdrive" color="#ea580c" enabled={drive?.enabled} icon={Zap}
              onToggle={(v: boolean) => setDrive(d => ({ ...d, enabled: v }))}>
              <div className="flex gap-1 mb-3 justify-center">
                {DRIVE_MODES.map(m => (
                  <button key={m} onClick={() => setDrive(d => ({ ...d, mode: m }))} className={`
                    px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-widest rounded transition-all duration-200
                    ${drive?.mode === m ? "bg-orange-600 text-white" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"}
                  `}>{m.slice(0,4)}</button>
                ))}
              </div>
              <KnobRow items={[
                { label: "Gain",  value: drive?.gain,  color: "#ea580c", onChange: (v: number) => setDrive(d => ({ ...d, gain: v })) },
                { label: "Tone",  value: drive?.tone,  color: "#f97316", onChange: (v: number) => setDrive(d => ({ ...d, tone: v })) },
                { label: "Level", value: drive?.level, color: "#fbbf24", onChange: (v: number) => setDrive(d => ({ ...d, level: v })) },
              ]}/>
            </EffectPanel>
          </>
        );
      case "Modulation":
        return (
          <EffectPanel title="Modulation" color="#a855f7" enabled={mod?.enabled} icon={Waves}
            onToggle={(v: boolean) => setMod(m => ({ ...m, enabled: v }))}>
            <div className="flex flex-wrap gap-1 mb-3 justify-center">
              {MOD_MODES.map(m => (
                <button key={m} onClick={() => setMod(d => ({ ...d, mode: m }))} className={`
                  px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-widest rounded transition-all duration-200
                  ${mod?.mode === m ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"}
                `}>{m.slice(0,4)}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 mb-3 justify-center">
              {LFO_SHAPES.map(s => (
                <button key={s} onClick={() => setMod(d => ({ ...d, shape: s }))} className={`
                  px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-widest rounded transition-all duration-200
                  ${mod?.shape === s ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"}
                `}>{s.slice(0,4)}</button>
              ))}
            </div>
            <KnobRow items={[
              { label: "Rate",  value: mod?.rate / 8,  color: "#a855f7", onChange: (v: number) => setMod(m => ({ ...m, rate: v * 8 })) },
              { label: "Depth", value: mod?.depth,      color: "#c084fc", onChange: (v: number) => setMod(m => ({ ...m, depth: v })) },
              { label: "Mix",   value: mod?.mix,        color: "#d8b4fe", onChange: (v: number) => setMod(m => ({ ...m, mix: v })) },
            ]}/>
          </EffectPanel>
        );
      case "Space":
        return (
          <>
            {/* Delay */}
            <EffectPanel title="Echo Delay" color="#ec4899" enabled={delay?.enabled} icon={Clock}
              onToggle={(v: boolean) => setDelay(d => ({ ...d, enabled: v }))}>
              <KnobRow items={[
                { label: "Time",     value: delay?.time / 2,     color: "#ec4899", onChange: (v: number) => setDelay(d => ({ ...d, time: v * 2 })) },
                { label: "Feedback", value: delay?.feedback,     color: "#f472b6", onChange: (v: number) => setDelay(d => ({ ...d, feedback: v })) },
                { label: "Mix",      value: delay?.mix,          color: "#f9a8d4", onChange: (v: number) => setDelay(d => ({ ...d, mix: v })) },
              ]}/>
            </EffectPanel>
            {/* Reverb */}
            <EffectPanel title="Reverb" color="#06b6d4" enabled={reverb?.enabled} icon={Wind}
              onToggle={(v: boolean) => setReverb(r => ({ ...r, enabled: v }))}>
              <KnobRow items={[
                { label: "Room",    value: reverb?.roomSize, color: "#06b6d4", onChange: (v: number) => setReverb(r => ({ ...r, roomSize: v })) },
                { label: "Damp",    value: reverb?.damping,  color: "#22d3ee", onChange: (v: number) => setReverb(r => ({ ...r, damping: v })) },
                { label: "Mix",     value: reverb?.mix,      color: "#67e8f9", onChange: (v: number) => setReverb(r => ({ ...r, mix: v })) },
              ]}/>
            </EffectPanel>
          </>
        );
      default:
        return null;
    }
  };

  // Effect states
  const [gate,  setGate]  = useState({ enabled: true,  threshold: 0.02 });
  const [comp,  setComp]  = useState({ enabled: true,  threshold: -24, ratio: 4 });
  const [eq,    setEq]    = useState({ enabled: true,  low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 4000 });
  const [drive, setDrive] = useState({ enabled: false, gain: 0.5, tone: 0.6, level: 0.7, mode: "overdrive" });
  const [mod,   setMod]   = useState({ enabled: false, rate: 1.5, depth: 0.5, mix: 0.5, mode: "chorus", shape: "sine" });
  const [delay, setDelay] = useState({ enabled: false, time: 0.4, feedback: 0.4, mix: 0.35 });
  const [reverb,setReverb]= useState({ enabled: false, roomSize: 0.5, damping: 0.5, mix: 0.3 });
  const [amp,   setAmp]   = useState({ enabled: true,  gain: 0.5, tone: 0.5, level: 0.5 });

  // Apply to engine whenever state changes
  useEffect(() => { apply({ drive }); },  [drive, apply]);
  useEffect(() => { apply({ mod }); },    [mod, apply]);
  useEffect(() => { apply({ delay }); },  [delay, apply]);
  useEffect(() => { apply({ reverb }); }, [reverb, apply]);
  useEffect(() => { apply({ amp }); },    [amp, apply]);
  useEffect(() => { apply({ eq }); },     [eq, apply]);
  useEffect(() => { apply({ master: volume }); }, [volume, apply]);

  const isActive = status === "active";

  return (
    <div className="min-h-screen bg-black text-zinc-300 font-sans selection:bg-orange-500/30 overflow-x-hidden">
      {/* Background patterns */}
      <div className="fixed inset-0 pointer-events-none opacity-20">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,#ea580c22,transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#18181b_1px,transparent_1px),linear-gradient(to_bottom,#18181b_1px,transparent_1px)] bg-[size:40px_40px]" />
      </div>

      <div className="relative max-w-4xl mx-auto px-4 py-8 md:py-12">
        {/* Header Section */}
        <header className="flex flex-col items-center mb-12 text-center">
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 mb-2"
          >
            <Zap size={14} className="text-orange-500" />
            <span className="text-[10px] uppercase tracking-[0.4em] font-bold text-zinc-500">Professional Audio</span>
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-4xl md:text-6xl font-black tracking-tighter text-white mb-6 italic"
          >
            TONE<span className="text-orange-600">MASTER</span>
          </motion.h1>

          <div className="flex flex-wrap items-center justify-center gap-6 p-4 rounded-2xl bg-zinc-900/50 border border-zinc-800 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${isActive ? "bg-emerald-500 shadow-[0_0_10px_#10b981]" : "bg-zinc-800"}`} />
              <span className="text-[10px] uppercase tracking-widest font-mono text-zinc-400">
                {status === "idle" ? "System Ready" : status === "connecting" ? "Initializing..." : isExternal ? "iRig Connected" : "Built-in Mic"}
              </span>
            </div>
            <div className="h-6 w-px bg-zinc-800 hidden md:block" />
            <VUMeter level={inputLevel} />
          </div>
        </header>

        {/* Tuner Section */}
        <div className="fixed bottom-4 left-4 z-40">
          <button 
            onClick={() => setShowTuner(!showTuner)}
            className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest hover:text-white hover:border-zinc-600 transition-all"
          >
            {showTuner ? "Hide Tuner" : "Show Tuner"}
          </button>
          {showTuner && (
            <div className="mt-2">
              <Tuner note={tuning.note} cents={tuning.cents} />
            </div>
          )}
        </div>

        {/* Main Controls */}
        <div className="flex flex-col md:flex-row items-center justify-center gap-4 mb-12">
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={isActive ? stop : start} 
            className={`
              flex items-center gap-3 px-8 py-4 rounded-xl font-bold tracking-widest uppercase text-xs transition-all duration-300
              ${isActive 
                ? "bg-red-600/10 text-red-500 border border-red-500/50 hover:bg-red-600/20 shadow-[0_0_20px_rgba(239,68,68,0.2)]" 
                : "bg-emerald-600/10 text-emerald-500 border border-emerald-500/50 hover:bg-emerald-600/20 shadow-[0_0_20px_rgba(16,185,129,0.2)]"}
            `}
          >
            {isActive ? <Power size={16} /> : <Activity size={16} />}
            {isActive ? "Bypass System" : "Engage Engine"}
          </motion.button>

          <div className="flex flex-col gap-4 items-center">
            <div className="flex gap-2 p-1.5 rounded-xl bg-zinc-900/80 border border-zinc-800">
              {Object.keys({ ...PRESETS, ...customPresets }).map(name => (
                <button 
                  key={name} 
                  onClick={() => loadPreset(name, { ...PRESETS, ...customPresets }[name])} 
                  className={`
                    px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all duration-200
                    ${activePreset === name 
                      ? "bg-orange-600 text-white shadow-lg" 
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"}
                  `}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input 
                type="text" 
                value={newPresetName} 
                onChange={(e) => setNewPresetName(e.target.value)}
                placeholder="Preset Name"
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-xs text-white w-40"
              />
              <button onClick={savePreset} className="px-4 py-2 bg-zinc-800 text-white text-xs font-bold rounded-lg hover:bg-zinc-700">Save Preset</button>
            </div>
          </div>
        </div>

        {/* Tuner Section */}
        <div className="fixed bottom-4 left-4 z-40">
          <button 
            onClick={() => setShowTuner(!showTuner)}
            className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest hover:text-white hover:border-zinc-600 transition-all"
          >
            {showTuner ? "Hide Tuner" : "Show Tuner"}
          </button>
          {showTuner && (
            <div className="mt-2">
              <Tuner note={tuning.note} cents={tuning.cents} />
            </div>
          )}
        </div>

        {/* Effects Grid */}
        <div className="mb-12 p-4 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 shadow-inner">
          <div className="flex justify-center gap-2 mb-6">
            {tabs.map(tab => (
              <button 
                key={tab} 
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${activeTab === tab ? "bg-gradient-to-r from-orange-600 to-red-600 text-white shadow-[0_0_15px_rgba(234,88,12,0.5)]" : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"}`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {renderEffects()}
          </div>
        </div>

        {/* Master Output Section */}
        <footer className="mt-12 p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 backdrop-blur-md">
          <div className="flex flex-col md:flex-row items-center gap-8">
            <div className="flex items-center gap-4 min-w-[140px]">
              <div className="p-3 rounded-xl bg-orange-600/10 text-orange-500">
                <Volume2 size={20} />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Output</span>
                <span className="text-sm font-mono font-bold text-white">Master Gain</span>
              </div>
            </div>
            
            <div className="flex-1 w-full">
              <Slider value={volume} onChange={(v: number) => { setVolume(v); apply({ master: v }); }} color="#ea580c"/>
            </div>

            <div className="flex items-center gap-4 min-w-[100px] justify-end">
              <span className="text-2xl font-mono font-black text-orange-600 tabular-nums">
                {Math.round(volume * 100)}
              </span>
              <div className="flex flex-col gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${volume > 0.8 ? "bg-red-500" : "bg-zinc-800"}`} />
                <div className={`w-1.5 h-1.5 rounded-full ${volume > 0.4 ? "bg-orange-500" : "bg-zinc-800"}`} />
                <div className={`w-1.5 h-1.5 rounded-full ${volume > 0 ? "bg-emerald-500" : "bg-zinc-800"}`} />
              </div>
            </div>
          </div>
        </footer>

        {/* Mobile Info */}
        <div className="mt-8 text-center">
          <p className="text-[10px] text-zinc-600 uppercase tracking-[0.2em]">
            Optimized for Mobile PWA • Low Latency Audio Engine
          </p>
        </div>
      </div>

      {/* Connection Helper */}
      <AnimatePresence>
        {!isActive && status === "idle" && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md p-4 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl z-50"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-orange-600/10 text-orange-500 shrink-0">
                <Mic size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-white mb-1">Ready to play?</h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                  Connect your guitar using an interface like iRig, or use your device's microphone. Use headphones to avoid feedback.
                </p>
                <button 
                  onClick={start}
                  className="w-full py-2.5 rounded-lg bg-orange-600 text-white text-[10px] font-bold uppercase tracking-widest hover:bg-orange-700 transition-colors"
                >
                  Start Audio Engine
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {!isActive && status === "error" && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md p-4 rounded-2xl bg-red-900/20 border border-red-500/50 shadow-2xl z-50 backdrop-blur-md"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-red-600/10 text-red-500 shrink-0">
                <AlertCircle size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-white mb-1">Access Required</h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                  {errorMessage || "Microphone access is required to use ToneMaster. Please check your browser settings and try again."}
                </p>
                <button 
                  onClick={() => { setStatus("idle"); setErrorMessage(null); }}
                  className="w-full py-2.5 rounded-lg bg-zinc-800 text-white text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-700 transition-colors mb-4"
                >
                  Try Again
                </button>

                <div className="pt-4 border-t border-red-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <HelpCircle size={12} className="text-red-400" />
                    <h4 className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Troubleshooting</h4>
                  </div>
                  <ul className="text-[10px] text-zinc-500 space-y-1.5 list-none">
                    <li className="flex gap-2">
                      <span className="text-red-500/50">•</span>
                      <span>Click the <b>camera/mic icon</b> in your browser's address bar.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-red-500/50">•</span>
                      <span>Ensure <b>"Allow"</b> is selected for this site.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-red-500/50">•</span>
                      <span>Check if another application is using your microphone.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-red-500/50">•</span>
                      <span>Refresh the page and try starting again.</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #fff;
          border: 4px solid #ea580c;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(234,88,12,0.4);
          margin-top: -7px;
        }
        input[type=range]::-webkit-slider-runnable-track {
          width: 100%;
          height: 6px;
          background: #18181b;
          border-radius: 3px;
        }
      `}</style>
    </div>
  );
}
