import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps, type RunResult } from './run.ts';
import type { RobotBridge } from '../bridge/robot.ts';
import type { Logger } from '../pod/logger.ts';

/** 事件名与机器人真实信号的对应关系（main.ts 里把 robot.on(...) 接到 fire） */
export const RULE_EVENTS = ['touch', 'pickedUp', 'putDown', 'cliff', 'chargerOn', 'chargerOff', 'button'] as const;
export type RuleEvent = typeof RULE_EVENTS[number];

export const RULE_EVENT_LABELS: Record<string, string> = {
  touch: '被摸头',
  pickedUp: '被抱起来',
  putDown: '被放下来',
  cliff: '看到桌边',
  chargerOn: '放上充电仓',
  chargerOff: '离开充电仓',
  button: '按了背上的按钮'
};

export interface Rule {
  id: string;
  event: string;
  name?: string;
  steps: any[];
  loops?: number;
  enabled?: boolean;
}

export interface RulesDeps {
  robot: RobotBridge;
  rootDir: string;
  log: Logger;
  /** 规则真的跑了一次（用来写互动记录 / 推送前端） */
  onRun?: (rule: Rule, res: RunResult) => void;
}

const COOLDOWN_MS = 4000;
const MAX_STEPS = 60;
const MAX_RULES = 40;

/**
 * 「当……就……」自动反应。
 * 机器人自己会发的几个信号（摸头、被抱起、桌边、充电台、按钮）都在这上面挂钩子，
 * 触发后按顺序跑一段和「编程」页一样的动作序列。同一时间只允许跑一段。
 */
export class RulesEngine {
  private file: string;
  private deps: RulesDeps;
  private rules: Rule[] = [];
  private busy = false;
  private lastRun = new Map<string, number>();
  constructor(deps: RulesDeps) {
    this.deps = deps;
    this.file = join(deps.rootDir, 'data', 'rules.json');
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const items = Array.isArray(raw) ? raw : raw?.items;
      if (Array.isArray(items)) this.rules = items.map((r: any) => this.normalize(r)).filter(Boolean) as Rule[];
    } catch (e) {
      this.deps.log.error('rules load failed: ' + (e as Error).message);
    }
  }

  private save(): void {
    try { writeFileSync(this.file, JSON.stringify({ items: this.rules }, null, 2), 'utf8'); } catch (e) {
      this.deps.log.error('rules save failed: ' + (e as Error).message);
    }
  }

  private normalize(r: any): Rule | null {
    const event = String(r?.event ?? '');
    if (!(RULE_EVENTS as readonly string[]).includes(event)) return null;
    const steps = Array.isArray(r?.steps) ? r.steps.filter((s: any) => s && typeof s === 'object').slice(0, MAX_STEPS) : [];
    if (!steps.length) return null;
    return {
      id: String(r?.id ?? ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
      event,
      name: r?.name ? String(r.name).slice(0, 40) : undefined,
      steps,
      loops: Math.min(Math.max(Number(r?.loops ?? 1), 1), 5),
      enabled: r?.enabled !== false
    };
  }

  list(): Rule[] { return this.rules.map(r => ({ ...r })); }

  /** 整份替换（前端每次「运行积木」都会把当次工作区里的帽子积木整份传上来） */
  replace(items: unknown): Rule[] {
    const list = (Array.isArray(items) ? items : []).map(r => this.normalize(r)).filter(Boolean) as Rule[];
    this.rules = list.slice(0, MAX_RULES);
    this.save();
    return this.list();
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.id !== id);
    if (this.rules.length !== before) { this.save(); return true; }
    return false;
  }

  clear(): void { this.rules = []; this.save(); }

  /** 手动程序和自动反应互斥：谁先拿到谁跑 */
  tryAcquire(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  release(): void { this.busy = false; }

  get isBusy(): boolean { return this.busy; }

  /** 机器人发来一个信号：跑所有匹配的规则 */
  async fire(event: string): Promise<void> {
    const hits = this.rules.filter(r => r.event === event && r.enabled !== false);
    if (!hits.length) return;
    if (!this.tryAcquire()) {
      this.deps.log.info('rules: ' + event + ' 到得太密，正在忙，这次跳过');
      return;
    }
    try {
      for (const rule of hits) {
        const since = Date.now() - (this.lastRun.get(rule.id) ?? 0);
        if (since < COOLDOWN_MS) continue;
        this.lastRun.set(rule.id, Date.now());
        this.deps.log.info('rules: 触发「' + event + '」 -> ' + rule.steps.length + ' 步');
        const res = await runSteps(this.deps.robot, this.deps.rootDir, rule.steps, rule.loops ?? 1, { maxMs: 120000 });
        try { this.deps.onRun?.(rule, res); } catch { /* ignore */ }
      }
    } finally {
      this.release();
    }
  }
}
