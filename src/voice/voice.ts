import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps, speak } from '../program/run.ts';
import { createOpusDecoder, type OpusDecoder } from '../audio/opus.ts';
import type { RobotBridge } from '../bridge/robot.ts';

export interface VoiceTrigger {
  id: string;
  phrase: string;
  steps: any[];
  enabled: boolean;
  builtin?: boolean;
}

export interface HeardEvent {
  ts: number;
  text: string;
  ms: number;
  matched: string | null;
  device: string;
  error?: string;
}

export interface VoiceOpts {
  robot: RobotBridge;
  rootDir: string;
  log: { info: (s: string) => void; error: (s: string) => void };
  stt: { ready: boolean; model: string; transcribe: (pcm: Buffer, sampleRate?: number) => { text: string; ms: number } };
  onEvent?: (type: string, payload: unknown) => void;
}

const BUILTIN: VoiceTrigger[] = [
  { id: 'b-hello', phrase: '你好', steps: [{ type: 'anim', name: 'anim_greeting_happy_03' }, { type: 'say', text: '你好呀，我是 Vector！' }], enabled: true, builtin: true },
  { id: 'b-hi', phrase: '嗨', steps: [{ type: 'anim', name: 'anim_greeting_happy_03' }, { type: 'say', text: '嗨！很高兴见到你。' }], enabled: true, builtin: true },
  { id: 'b-dance', phrase: '跳舞', steps: [{ type: 'anim', name: 'anim_dancebeat_eyebeat_01', loops: 2 }], enabled: true, builtin: true },
  { id: 'b-dance2', phrase: '跳个舞', steps: [{ type: 'anim', name: 'anim_dancebeat_cantdothat_01', loops: 2 }], enabled: true, builtin: true },
  { id: 'b-turn', phrase: '转个圈', steps: [{ type: 'turn', deg: 360 }], enabled: true, builtin: true },
  { id: 'b-come', phrase: '过来', steps: [{ type: 'intent', name: 'intent_imperative_come' }], enabled: true, builtin: true },
  { id: 'b-look', phrase: '看着我', steps: [{ type: 'intent', name: 'intent_imperative_lookatme' }], enabled: true, builtin: true },
  { id: 'b-fist', phrase: '碰个拳', steps: [{ type: 'intent', name: 'intent_play_fistbump' }], enabled: true, builtin: true },
  { id: 'b-popa', phrase: '翘轮子', steps: [{ type: 'intent', name: 'intent_play_popawheelie' }], enabled: true, builtin: true },
  { id: 'b-cube', phrase: '滚方块', steps: [{ type: 'intent', name: 'intent_play_rollcube' }], enabled: true, builtin: true },
  { id: 'b-fwd', phrase: '前进', steps: [{ type: 'forward', mm: 200 }], enabled: true, builtin: true },
  { id: 'b-back', phrase: '后退', steps: [{ type: 'back', mm: 200 }], enabled: true, builtin: true },
  { id: 'b-headup', phrase: '抬头', steps: [{ type: 'head', angle: -0.5 }], enabled: true, builtin: true },
  { id: 'b-headdown', phrase: '低头', steps: [{ type: 'head', angle: 0.4 }], enabled: true, builtin: true },
  { id: 'b-liftup', phrase: '举高', steps: [{ type: 'lift', height: 80 }], enabled: true, builtin: true },
  { id: 'b-liftdown', phrase: '放下', steps: [{ type: 'lift', height: 30 }], enabled: true, builtin: true },
  { id: 'b-stop', phrase: '停下', steps: [{ type: 'stop' }], enabled: true, builtin: true },
  { id: 'b-sleep', phrase: '睡觉', steps: [{ type: 'intent', name: 'intent_system_sleep' }], enabled: true, builtin: true },
  { id: 'b-photo', phrase: '拍照', steps: [{ type: 'photo' }, { type: 'say', text: '咔嚓！拍好啦。' }], enabled: true, builtin: true }
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s，。！？、,.!?"'`~\-]/g, '');
}

export class VoiceService {
  triggers: VoiceTrigger[] = [];
  lastHeard: HeardEvent | null = null;
  history: HeardEvent[] = [];
  busy = false;
  enabled = true;
  private file: string;
  private robot: RobotBridge;
  private rootDir: string;
  private log: { info: (s: string) => void; error: (s: string) => void };
  private stt: VoiceOpts['stt'];
  private onEvent?: (type: string, payload: unknown) => void;
  private uttDir: string;
  private opusDec: OpusDecoder | null = null;
  private opusFailed = false;

  constructor(opts: VoiceOpts) {
    this.robot = opts.robot;
    this.rootDir = opts.rootDir;
    this.log = opts.log;
    this.stt = opts.stt;
    this.onEvent = opts.onEvent;
    this.file = join(opts.rootDir, 'data', 'voiceCommands.json');
    this.uttDir = join(opts.rootDir, 'data', 'utterances');
    try { mkdirSync(this.uttDir, { recursive: true }); } catch { /* ignore */ }
    this.load();
  }

  get sttReady(): boolean { return this.stt.ready; }
  get sttModel(): string { return this.stt.model; }

  load(): void {
    try {
      if (existsSync(this.file)) {
        const j = JSON.parse(readFileSync(this.file, 'utf8'));
        const user = Array.isArray(j.triggers) ? j.triggers : [];
        this.triggers = [...BUILTIN.map(b => ({ ...b })), ...user];
        if (j.enabled === false) this.enabled = false;
        return;
      }
    } catch (e) {
      this.log.error('voice: failed to read commands: ' + (e as Error).message);
    }
    this.triggers = [...BUILTIN.map(b => ({ ...b }))];
    this.save();
  }

  save(): void {
    try {
      const user = this.triggers.filter(t => !t.builtin);
      writeFileSync(this.file, JSON.stringify({ enabled: this.enabled, triggers: user }, null, 2));
    } catch (e) {
      this.log.error('voice: failed to write commands: ' + (e as Error).message);
    }
  }

  addTrigger(phrase: string, steps: any[]): VoiceTrigger {
    const t: VoiceTrigger = { id: 'u-' + Date.now().toString(36), phrase, steps, enabled: true };
    this.triggers.push(t);
    this.save();
    return t;
  }

  removeTrigger(id: string): boolean {
    const i = this.triggers.findIndex(t => t.id === id);
    if (i < 0 || this.triggers[i].builtin) return false;
    this.triggers.splice(i, 1);
    this.save();
    return true;
  }

  updateTrigger(id: string, patch: Partial<VoiceTrigger>): boolean {
    const t = this.triggers.find(x => x.id === id);
    if (!t) return false;
    if (typeof patch.phrase === 'string') t.phrase = patch.phrase;
    if (Array.isArray(patch.steps)) t.steps = patch.steps;
    if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled;
    this.save();
    return true;
  }

  match(text: string): VoiceTrigger | null {
    const n = norm(text);
    if (!n) return null;
    const active = this.triggers.filter(t => t.enabled);
    // longest phrase wins, so "跳舞" beats "跳"
    const sorted = [...active].sort((a, b) => norm(b.phrase).length - norm(a.phrase).length);
    for (const t of sorted) {
      if (n.includes(norm(t.phrase))) return t;
    }
    return null;
  }

  /** Keep the last few raw utterances on disk; handy when the recogniser mishears. */
  private saveUtterance(raw: Buffer, encoding: string): void {
    try {
      const ext = /opus/i.test(encoding) ? 'ogg' : 'pcm';
      writeFileSync(join(this.uttDir, `${Date.now()}.${ext}`), raw);
      const files = readdirSync(this.uttDir).filter(n => n.endsWith('.ogg') || n.endsWith('.pcm')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 20))) {
        try { unlinkSync(join(this.uttDir, old)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /** OGG_OPUS -> 16k mono PCM16, LINEAR_PCM passes through. */
  private toPcm(raw: Buffer, encoding: string): Buffer {
    if (!/opus/i.test(encoding)) return raw;
    if (this.opusFailed) return Buffer.alloc(0);
    try {
      if (!this.opusDec) this.opusDec = createOpusDecoder(16000);
      return this.opusDec.decodeOgg(raw);
    } catch (e) {
      this.opusFailed = true;
      this.log.error('voice: opus decoder init failed: ' + (e as Error).message);
      return Buffer.alloc(0);
    }
  }

  async handlePcm(raw: Buffer, device = 'robot', encoding = 'LINEAR_PCM'): Promise<HeardEvent> {
    const t0 = Date.now();
    this.saveUtterance(raw, encoding);
    const pcm = this.toPcm(raw, encoding);
    let text = '';
    let sttMs = 0;
    try {
      const r = this.stt.transcribe(pcm);
      text = r.text;
      sttMs = r.ms;
    } catch (e) {
      this.log.error('voice: stt failed: ' + (e as Error).message);
    }
    const ev: HeardEvent = { ts: Date.now(), text, ms: sttMs, matched: null, device };
    this.push(ev);
    this.log.info(`voice: heard "${text}" via ${encoding} (raw ${raw.length}B -> pcm ${(pcm.length / 32000).toFixed(1)}s, stt ${sttMs}ms, total ${Date.now() - t0}ms)`);
    if (text) await this.dispatch(text, device, ev);
    return ev;
  }

  async handleText(text: string, device = 'manual'): Promise<HeardEvent> {
    const ev: HeardEvent = { ts: Date.now(), text, ms: 0, matched: null, device };
    this.push(ev);
    await this.dispatch(text, device, ev);
    return ev;
  }

  private push(ev: HeardEvent): void {
    this.lastHeard = ev;
    this.history.unshift(ev);
    if (this.history.length > 30) this.history.pop();
    this.onEvent?.('heard', ev);
  }

  private async dispatch(text: string, device: string, ev: HeardEvent): Promise<void> {
    if (!this.enabled) return;
    const t = this.match(text);
    if (!t) {
      this.onEvent?.('voiceUnmatched', { text });
      return;
    }
    ev.matched = t.phrase;
    this.onEvent?.('voiceMatch', { text, phrase: t.phrase, id: t.id });
    if (this.busy) {
      this.log.info('voice: busy, dropping "' + text + '"');
      ev.error = 'busy';
      return;
    }
    this.busy = true;
    try {
      this.log.info(`voice: matched "${text}" -> "${t.phrase}" (${t.steps.length} steps)`);
      await runSteps(this.robot, this.rootDir, t.steps, 1, { control: true });
    } catch (e) {
      ev.error = (e as Error).message;
      this.log.error('voice: run failed: ' + ev.error);
    } finally {
      this.busy = false;
    }
  }

  async say(text: string): Promise<void> {
    await speak(this.robot, this.rootDir, text, {});
  }
}
