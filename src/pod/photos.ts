import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PhotoItem { name: string; ts: number; bytes: number }

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return p(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3);
}

/** 相册：机器人拍的照片存在 data/photos，文件名带时间戳，取最新的排前面。 */
export class PhotoStore {
  dir: string;
  private seq = 0;
  constructor(rootDir: string) {
    this.dir = join(rootDir, 'data', 'photos');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  save(jpeg: Buffer): PhotoItem {
    const name = stamp() + '-' + (this.seq++ % 1000) + '.jpg';
    writeFileSync(join(this.dir, name), jpeg);
    return { name, ts: Date.now(), bytes: jpeg.length };
  }

  list(limit = 60): PhotoItem[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(n => /\.jpe?g$/i.test(n)); } catch { return []; }
    const items: PhotoItem[] = [];
    for (const n of names) {
      try {
        const st = statSync(join(this.dir, n));
        items.push({ name: n, ts: st.mtimeMs, bytes: st.size });
      } catch { /* 文件刚被删掉，跳过 */ }
    }
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, Math.max(1, Math.min(500, limit)));
  }

  read(name: string): Buffer | null {
    if (!this.safe(name)) return null;
    const f = join(this.dir, name);
    if (!existsSync(f)) return null;
    try { return readFileSync(f); } catch { return null; }
  }

  remove(name: string): boolean {
    if (!this.safe(name)) return false;
    const f = join(this.dir, name);
    if (!existsSync(f)) return false;
    try { unlinkSync(f); return true; } catch { return false; }
  }

  private safe(name: string): boolean {
    // 两种命名都要认：PhotoStore.save() = 20261020-033519-280-0.jpg，savePhoto() = p20261020-033519-280.jpg
    return /^p?[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]{1,3})?\.jpg$/.test(name);
  }
}

/** 给程序执行器用的简易保存（不知道 rootDir 之外的上下文）。 */
export function savePhoto(rootDir: string, jpeg: Buffer): PhotoItem {
  const dir = join(rootDir, 'data', 'photos');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = 'p' + stamp() + '.jpg';
  writeFileSync(join(dir, name), jpeg);
  return { name, ts: Date.now(), bytes: jpeg.length };
}
