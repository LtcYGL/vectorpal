import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { savePhoto } from '../pod/photos.ts';
import { parseWav, resampleLinear, toPcm16 } from '../audio/wav.ts';
import { synthesizeToWav } from '../audio/tts.ts';
import type { RobotBridge } from '../bridge/robot.ts';

export interface SpeakOpts { voice?: string; rate?: number; volume?: number }

export async function speak(robot: RobotBridge, rootDir: string, text: string, opts: SpeakOpts = {}): Promise<void> {
  const out = join(rootDir, 'logs', 'tts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.wav');
  let w;
  try {
    await synthesizeToWav(text, out, { voice: opts.voice, rate: opts.rate, volume: 100 });
    w = parseWav(readFileSync(out));
  } finally {
    // 临时 wav 只是给解码器用的，用完删掉，别在 logs/ 里越堆越多
    try { unlinkSync(out); } catch { /* ignore */ }
  }
  const rate = 16000;
  const pcm = toPcm16(resampleLinear(w.samples, w.sampleRate, rate));
  await robot.streamPcm(pcm, rate, opts.volume ?? 90);
}

/**
 * 动画该等多久：固件不回包，只能照 anim_manifest.json 里的时长等它跳完。
 * 不等的话下一步会在动画中途开始，看起来就是“动作没做完就干别的了”。
 */
function animHoldMs(rootDir: string, name: string): number {
  try {
    const c: any = JSON.parse(readFileSync(join(rootDir, 'data', 'animations.json'), 'utf8'));
    const ms = Number(c?.lengths?.[name] ?? 0);
    if (ms > 0) return Math.min(ms + 300, 20000);
  } catch { /* 没清单就按默认 */ }
  return 1500;
}

export interface RunResult { ok: boolean; ms: number; results: any[]; aborted?: boolean }

export interface RunOpts {
  control?: boolean;
  /** Returns true when the caller wants the program to stop at the next step boundary. */
  isAborted?: () => boolean;
  /** Hard wall-clock limit; the motors are stopped when it is exceeded. */
  maxMs?: number;
}

export async function runSteps(
  robot: RobotBridge,
  rootDir: string,
  steps: any[],
  loops = 1,
  opts: RunOpts = {}
): Promise<RunResult> {
  const results: any[] = [];
  const t0 = Date.now();
  const maxMs = Math.min(Math.max(Number(opts.maxMs ?? 240000), 1000), 600000);
  const halted = (): false | 'aborted' | 'timeout' => {
    if (opts.isAborted?.()) return 'aborted';
    if (Date.now() - t0 > maxMs) return 'timeout';
    return false;
  };
  try {
    if (opts.control !== false) await robot.ensureControl();
    for (let n = 0; n < loops; n++) {
      for (const s of steps) {
        const stop = halted();
        if (stop) {
          await robot.stopAll().catch(() => {});
          return { ok: false, aborted: true, ms: Date.now() - t0, results, ...{ error: stop } } as RunResult;
        }
        const t = String(s.type ?? '');
        if (t === 'say') {
          await speak(robot, rootDir, String(s.text ?? ''), { voice: s.voice, rate: s.rate, volume: Number(s.volume ?? 90) });
          results.push({ step: t, ok: true });
        } else if (t === 'anim') {
          const name = String(s.name);
          await robot.playAnimation(name, Number(s.loops ?? 1), animHoldMs(rootDir, name));
          results.push({ step: t, ok: true, name: s.name });
        } else if (t === 'forward' || t === 'back') {
          const mm = Math.abs(Number(s.mm ?? 100));
          const speed = Number(s.speed ?? 120);
          const ms = Math.min(Math.max((mm / speed) * 1000, 100), 8000);
          const v = t === 'forward' ? speed : -speed;
          await robot.driveFor(v, v, ms);
          results.push({ step: t, ok: true, mm });
        } else if (t === 'turn') {
          const deg = Number(s.deg ?? 90);
          const speed = Number(s.speed ?? 100);
          const ms = Math.min(Math.max(Math.abs(deg) * 9, 100), 8000);
          const sgn = deg < 0 ? -1 : 1;
          await robot.driveFor(-sgn * speed, sgn * speed, ms);
          results.push({ step: t, ok: true, deg });
        } else if (t === 'head') {
          await robot.moveHeadTo(Number(s.angle ?? 0));
          results.push({ step: t, ok: true });
        } else if (t === 'lift') {
          await robot.moveLiftTo(Number(s.height ?? 32));
          results.push({ step: t, ok: true });
        } else if (t === 'eye') {
          await robot.setEyeColor(Number(s.hue ?? 0.5), Number(s.saturation ?? 1), Number(s.light ?? 0.5));
          results.push({ step: t, ok: true });
        } else if (t === 'intent') {
          await robot.appIntent(String(s.name ?? s.intent ?? 'intent_system_noaudio'), String(s.param ?? ''));
          results.push({ step: t, ok: true, name: s.name });
        } else if (t === 'photo') {
          const buf = await robot.captureImage();
          const it = savePhoto(rootDir, buf);
          results.push({ step: t, ok: true, name: it.name });
        } else if (t === 'stop') {
          await robot.stopAll();
          results.push({ step: t, ok: true });
        } else if (t === 'wait') {
          await new Promise<void>(r => setTimeout(r, Math.min(Math.max(Number(s.ms ?? 1000), 50), 10000)));
          results.push({ step: t, ok: true });
        } else {
          results.push({ step: t, ok: false, error: 'unknown step' });
        }
      }
    }
    return { ok: true, ms: Date.now() - t0, results };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, results, ...{ error: (e as Error).message } } as RunResult;
  }
}
