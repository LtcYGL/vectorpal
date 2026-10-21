import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface TtsOptions { voice?: string; rate?: number; volume?: number; }

let voicesCache: { at: number; list: string[] } | null = null;

export async function listVoices(): Promise<string[]> {
  // 每次查音色都要起一个 powershell，缓存一下省得一直闪黑框
  if (voicesCache && Date.now() - voicesCache.at < 10 * 60 * 1000) return voicesCache.list;
  const list = await queryVoices();
  voicesCache = { at: Date.now(), list };
  return list;
}

function queryVoices(): Promise<string[]> {
  const script = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";
  return new Promise((resolve, reject) => {
    const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('error', e => reject(new Error('listVoices: 起不了 powershell：' + e.message)));
    p.on('close', c => c === 0 ? resolve(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) : reject(new Error('listVoices failed: ' + err)));
  });
}

/** Synthesize text to a WAV file using Windows SAPI. Returns the path. */
export async function synthesizeToWav(text: string, outPath: string, opts: TtsOptions = {}): Promise<string> {
  const txtPath = join(tmpdir(), 'vp_tts_' + Date.now() + '.txt');
  writeFileSync(txtPath, text, 'utf8');
  const voice = opts.voice ? `$s.SelectVoice('${opts.voice.replace(/'/g, "''")}');` : '';
  const rate = Number.isFinite(opts.rate) ? `$s.Rate = ${Math.max(-10, Math.min(10, Number(opts.rate)))};` : '';
  const vol = Number.isFinite(opts.volume) ? `$s.Volume = ${Math.max(0, Math.min(100, Number(opts.volume)))};` : '';
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    voice, rate, vol,
    `$t = Get-Content -LiteralPath '${txtPath}' -Raw -Encoding UTF8;`,
    `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}');`,
    '$s.Speak($t);',
    '$s.Dispose();'
  ].join(' ');
  return new Promise((resolve, reject) => {
    const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d.toString('utf8'));
    // powershell 起不来（被策略禁掉、路径没了）时 close 不会来，必须接 error，否则请求永远挂着
    p.on('error', e => {
      try { if (existsSync(txtPath)) unlinkSync(txtPath); } catch { /* ignore */ }
      reject(new Error('TTS: 起不了 powershell：' + e.message));
    });
    p.on('close', c => {
      try { if (existsSync(txtPath)) unlinkSync(txtPath); } catch { /* ignore */ }
      if (c !== 0) return reject(new Error('TTS failed: ' + err));
      if (!existsSync(outPath)) return reject(new Error('TTS produced no file'));
      const size = readFileSync(outPath).length;
      if (size < 1000) return reject(new Error(`TTS produced empty audio (size=${size}, exit=${c}, text=${JSON.stringify(text.slice(0, 40))}, voice=${opts.voice ?? '-'}, stderr=${err.trim().slice(0, 300)})`));
      resolve(outPath);
    });
  });
}
