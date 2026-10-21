import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 3 * 1024 * 1024;   // 单文件上限 3MB
const KEEP = 3;                      // 另外保留 3 个历史文件

export class Logger {
  private file: string;
  private writes = 0;
  constructor(logDir: string, name = 'pod.log') {
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, name);
  }
  /** 大约每 50 行检查一次体积，超过上限就滚动：pod.log -> pod.log.1 -> ... -> pod.log.3 */
  private rotate(): void {
    if (++this.writes < 50) return;
    this.writes = 0;
    try {
      if (statSync(this.file).size < MAX_BYTES) return;
    } catch { return; }
    try {
      for (let i = KEEP; i >= 1; i--) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        try { renameSync(from, `${this.file}.${i}`); } catch { /* 目标不存在就继续 */ }
      }
    } catch { /* 滚动失败不影响写日志 */ }
  }
  private stamp(): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  log(tag: string, msg: string): void {
    const line = `[${this.stamp()}] [${tag}] ${msg}`;
    console.log(line);
    this.rotate();
    try { appendFileSync(this.file, line + '\n'); } catch { /* ignore */ }
  }
  info(msg: string): void { this.log('pod', msg); }
  grpc(msg: string): void { this.log('grpc', msg); }
  mdns(msg: string): void { this.log('mdns', msg); }
  http(msg: string): void { this.log('http', msg); }
  error(msg: string): void { this.log('ERR ', msg); }
}