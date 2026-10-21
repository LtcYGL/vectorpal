import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.ts';

export interface ActivityItem {
  /** 本地时间 "2026-10-19 18:30:05" */
  ts: string;
  /** voice | say | program | anim | touch | pickedUp | charger | button | cliff | boot | shutdown | error */
  kind: string;
  /** 一句人话，直接给家长看 */
  title: string;
  detail?: Record<string, unknown>;
}

export interface DaySummary {
  date: string;
  count: number;
  first: string;
  last: string;
  kinds: Record<string, number>;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function todayStr(): string {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function today(): string {
  return todayStr();
}

function stamp(d = new Date()): string {
  return today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** 按天滚动的互动记录：一天一个 JSONL 文件，家长端只读这些数据。 */
export class ActivityLog {
  private dir: string;
  private log: Logger;
  private cache = new Map<string, ActivityItem[]>();
  private lastKey = '';
  private lastAt = 0;

  constructor(dir: string, log: Logger) {
    this.dir = dir;
    this.log = log;
    mkdirSync(dir, { recursive: true });
  }

  private file(date: string): string {
    return join(this.dir, 'activity-' + date + '.jsonl');
  }

  /** 记一条。kind+title 在 1.5 秒内重复会被吞掉（防止传感器抖动刷屏）。 */
  append(kind: string, title: string, detail?: Record<string, unknown>): void {
    const key = kind + '|' + title;
    const now = Date.now();
    if (key === this.lastKey && now - this.lastAt < 1500) return;
    this.lastKey = key;
    this.lastAt = now;
    const item: ActivityItem = { ts: stamp(), kind, title };
    if (detail) item.detail = detail;
    const date = today();
    try {
      appendFileSync(this.file(date), JSON.stringify(item) + '\n');
    } catch (e) {
      this.log.error('activity write failed: ' + (e as Error).message);
    }
    const list = this.cache.get(date);
    if (list) {
      list.push(item);
      if (list.length > 2000) list.splice(0, list.length - 2000);
    }
  }

  readDay(date: string, limit = 500): ActivityItem[] {
    const cached = this.cache.get(date);
    if (cached) return cached.slice(-limit);
    const path = this.file(date);
    if (!existsSync(path)) { this.cache.set(date, []); return []; }
    const items: ActivityItem[] = [];
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { items.push(JSON.parse(line)); } catch { /* skip broken line */ }
      }
    } catch (e) {
      this.log.error('activity read failed: ' + (e as Error).message);
    }
    this.cache.set(date, items);
    return items.slice(-limit);
  }

  /** 最近 N 天（含今天）的每日概览，新的在前。 */
  summary(days = 7): DaySummary[] {
    const out: DaySummary[] = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const items = this.readDay(date, 100000);
      const kinds: Record<string, number> = {};
      for (const it of items) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
      out.push({
        date,
        count: items.length,
        first: items.length ? items[0].ts.slice(11) : '',
        last: items.length ? items[items.length - 1].ts.slice(11) : '',
        kinds
      });
    }
    return out;
  }
}
