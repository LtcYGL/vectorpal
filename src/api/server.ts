import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseWav, resampleLinear, toPcm16 } from '../audio/wav.ts';
import { synthesizeToWav, listVoices } from '../audio/tts.ts';
import { runSteps } from '../program/run.ts';
import type { Logger } from '../pod/logger.ts';
import type { JdocsStore } from '../pod/store.ts';
import type { VoiceService } from '../voice/voice.ts';
import type { ActivityLog } from '../pod/activity.ts';
import { todayStr } from '../pod/activity.ts';
import type { PhotoStore } from '../pod/photos.ts';
import type { RulesEngine } from '../program/rules.ts';
import { RULE_EVENTS, RULE_EVENT_LABELS } from '../program/rules.ts';
import { RobotBridge } from '../bridge/robot.ts';
import type { PairEngine } from '../pod/pair.ts';

interface Deps {
  log: Logger;
  store: JdocsStore;
  robot: RobotBridge;
  rootDir: string;
  protoDir: string;
  robotCert: string;
  bus?: { subs: Set<(t: string, p: unknown) => void> };
  voice?: VoiceService | null;
  activity?: ActivityLog | null;
  /** 监听地址；默认只给本机用 127.0.0.1，改成 0.0.0.0 才让手机/平板访问。 */
  host?: string;
  /** 局域网访问时要求的 PIN；为空则不校验。 */
  pin?: string;
  /** 本机在局域网里的 IP，给「设置 → 系统」显示访问地址用。 */
  lanIp?: string;
  /** 相册（机器人拍的照片）。 */
  photos?: PhotoStore | null;
  rules?: RulesEngine | null;
  /** 机器人最后一次打我们 :80 连通性检查的时间（ms）；它不为 0 说明机器人的联网会话还活着。 */
  cloudSeen?: () => number;
  /** SSH 接入（配对）引擎。 */
  pair?: PairEngine | null;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fileStat(p: string): { bytes: number; mtime: string } {
  try { const s = statSync(p); return { bytes: s.size, mtime: new Date(s.mtimeMs).toISOString() }; } catch { return { bytes: 0, mtime: '' }; }
}

function readPid(p: string): number {
  try {
    const n = Number(readFileSync(p, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function isLoopback(addr?: string): boolean {
  if (!addr) return true;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'access-control-allow-origin': '*' });
  res.end(buf);
}

const SETTINGS_BOOL = ['clock_24_hour', 'dist_is_metric', 'temp_is_fahrenheit'];
const SETTINGS_ENUM: Record<string, number> = { eye_color: 6, master_volume: 5, button_wakeword: 1 };

/** Keep only known RobotSettingsConfig fields and coerce them to their protobuf types. */
function sanitizeSettings(src: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of SETTINGS_BOOL) if (typeof src[k] === 'boolean') out[k] = src[k];
  for (const [k, max] of Object.entries(SETTINGS_ENUM)) {
    if (src[k] === undefined || src[k] === null || src[k] === '') continue;
    const n = Number(src[k]);
    if (Number.isInteger(n) && n >= 0 && n <= max) out[k] = n;
  }
  for (const k of ['default_location', 'locale', 'time_zone']) {
    if (typeof src[k] === 'string' && src[k].trim()) out[k] = src[k].trim();
  }
  const eye = src.custom_eye_color;
  if (eye && typeof eye === 'object') {
    out.custom_eye_color = {
      hue: Math.min(Math.max(Number(eye.hue ?? 0), 0), 1),
      saturation: Math.min(Math.max(Number(eye.saturation ?? 1), 0), 1),
      enabled: !!eye.enabled
    };
  }
  return out;
}

/** 请求体上限：控制台最大也就是一段编程积木或一张照片的元信息，1MB 足够，防止误发大文件把内存吃满。 */
const MAX_BODY = 1 << 20;

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('请求太大（超过 1MB）');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function startApi(port: number, deps: Deps): Promise<void> {
  const { log, store, robot } = deps;
  let runToken = 0; // bumped by /api/program/stop so a running program bails out
  const sseClients = new Set<ServerResponse>();
  const broadcast = (type: string, payload: unknown) => {
    const line = `data: ${JSON.stringify({ type, payload })}\n\n`;
    for (const c of sseClients) { try { c.write(line); } catch { /* ignore */ } }
  };

  if (deps.bus) deps.bus.subs.add((t: string, p: unknown) => broadcast(t, p));

  robot.on('state', (s: any) => broadcast('state', {
    ts: s.ts, head: s.headAngleRad, lift: s.liftHeightMm, status: s.status,
    onCharger: s.onCharger, charging: s.charging, pickedUp: s.pickedUp, beingHeld: s.beingHeld,
    cliff: s.cliffDetected, button: s.buttonPressed, touch: s.touch, pose: s.pose,
    leftWheel: s.leftWheelMmps, rightWheel: s.rightWheelMmps, proxMm: s.proxMm, stim: s.stim,
    battery: robot.battery
  }));
  robot.on('touch', (t: any) => broadcast('touch', t));
  robot.on('stim', (s: any) => broadcast('stim', s));
  robot.on('pickedUp', (v: boolean) => broadcast('pickedUp', v));
  robot.on('charger', (v: boolean) => broadcast('charger', v));
  robot.on('cliff', (v: boolean) => broadcast('cliff', v));
  robot.on('button', (v: boolean) => broadcast('button', v));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS 预检必须排在 PIN 之前：浏览器不会给预检带自定义头，先拦就永远 401，
    // 平板/手机上整页都变成“pin required”。
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
      return res.end();
    }

    // 局域网访问要 PIN：本机（127.0.0.1）免检，其它来源的 /api 请求必须带对
    // （页面本身不拦，否则平板打开只会看到一行 JSON）
    if (deps.pin && path.startsWith('/api/') && !isLoopback(req.socket.remoteAddress)) {
      const given = String(req.headers['x-vp-pin'] ?? url.searchParams.get('pin') ?? '');
      if (given !== deps.pin) return json(res, 401, { error: 'pin required', pinRequired: true });
    }
    try {
      if (path === '/api/health') return json(res, 200, { ok: true });

      // ---- 接入机器人（配对）--------------------------------------------
      if (path === '/api/pair/status' && method === 'GET') {
        return json(res, 200, deps.pair ? deps.pair.get() : { running: false, step: 'unavailable' });
      }
      if (path === '/api/pair/robots' && method === 'GET') {
        const online = robot.stateAgeMs < 5000;
        return json(res, 200, {
          online,
          robots: store.botInfo.robots.map(r => ({
            esn: r.esn, ip: r.ip_address, guid: r.guid, paired: !!r.guid, activated: !!r.activated
          }))
        });
      }
      if (path === '/api/pair/ssh' && method === 'POST') {
        if (!deps.pair) return json(res, 500, { error: '配对引擎没启动' });
        const body = await readBody(req);
        const ip = String(body.ip ?? '').trim();
        let key = String(body.key ?? '');
        if (!key) {
          const cand = [
            join(deps.rootDir, 'data', 'keys', 'root_key'),
            join(process.env.USERPROFILE || '', '.ssh', 'vectorpal_root_key'),
            join(process.env.USERPROFILE || '', '.ssh', 'id_rsa')
          ].filter(p => p && existsSync(p));
          if (!cand.length) return json(res, 400, { error: '没找到 SSH 私钥，把文件选一下' });
          key = readFileSync(cand[0], 'utf8');
        }
        if (!key.includes('PRIVATE KEY')) return json(res, 400, { error: 'ssh 私钥格式不对（要 -----BEGIN ... PRIVATE KEY----- 那种）' });
        try {
          await deps.pair.start(ip, Buffer.from(key, 'utf8'));
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true, status: deps.pair.get() });
      }

      // ---- 互动记录（家长端）--------------------------------------------
      if (path === '/api/activity' && method === 'GET') {
        const want = url.searchParams.get('date') ?? '';
        const day = /^\d{4}-\d{2}-\d{2}$/.test(want) ? want : todayStr();
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 400), 1), 2000);
        const items = deps.activity ? deps.activity.readDay(day, limit) : [];
        return json(res, 200, { date: day, count: items.length, items });
      }
      if (path === '/api/activity/summary' && method === 'GET') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 7), 1), 30);
        return json(res, 200, { days, summary: deps.activity ? deps.activity.summary(days) : [] });
      }

      // ---- 系统：状态、日志尾巴、重启 / 退出 ----
      if (path === '/api/system/info' && method === 'GET') {
        const logsDir = join(deps.rootDir, 'logs');
        const wdPiece = readPid(join(deps.rootDir, 'keepalive.pid'));
        const lanIp = deps.lanIp ?? '';
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          node: process.version,
          platform: process.platform + ' ' + process.arch,
          host: deps.host ?? '127.0.0.1',
          port,
          lanIp,
          url: lanIp && (deps.host ?? '127.0.0.1') !== '127.0.0.1' ? 'http://' + lanIp + ':' + port : 'http://127.0.0.1:' + port,
          pinRequired: !!deps.pin,
          pin: isLoopback(req.socket.remoteAddress) ? (deps.pin ?? '') : '',
          watchdog: wdPiece && pidAlive(wdPiece) ? wdPiece : 0,
          logs: { pod: fileStat(join(logsDir, 'pod.log')), keepalive: fileStat(join(logsDir, 'keepalive.log')) },
          activityToday: deps.activity ? deps.activity.readDay(todayStr(), 5000).length : 0,
          robot: {
            connected: robot.isConnected,
            esn: robot.info?.esn ?? '',
            version: robot.version?.os ?? '',
            battery: robot.battery ?? null
          }
        });
      }
      if (path === '/api/system/log' && method === 'GET') {
        const name = String(url.searchParams.get('name') ?? 'pod');
        const want = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 200), 10), 2000);
        const file = join(deps.rootDir, 'logs', name === 'keepalive' ? 'keepalive.log' : 'pod.log');
        try {
          const all = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
          return json(res, 200, { name: name === 'keepalive' ? 'keepalive' : 'pod', file, lines: all.slice(-want), total: all.length });
        } catch (e) {
          return json(res, 200, { name, file, lines: [], total: 0, error: (e as Error).message });
        }
      }
      if (path === '/api/system/restart' && method === 'POST') {
        log.info('restart requested from console');
        json(res, 200, { ok: true, note: '正在重启，约 10 秒后自动回来' });
        setTimeout(() => process.exit(0), 400);
        return;
      }
      if (path === '/api/system/shutdown' && method === 'POST') {
        const wd = readPid(join(deps.rootDir, 'keepalive.pid'));
        const alive = wd && pidAlive(wd) ? wd : 0;
        log.info('shutdown requested from console (watchdog=' + (alive || 'none') + ')');
        deps.activity?.append('shutdown', '在控制台点了「完全退出」，要再打开得重新运行');
        json(res, 200, { ok: true, watchdog: alive });
        setTimeout(() => {
          if (alive) { try { process.kill(alive, 'SIGKILL'); } catch { /* ignore */ } }
          process.exit(0);
        }, 600);
        return;
      }
      if (path === '/api/status') {
        return json(res, 200, {
          pod: { bots: store.botInfo.robots, jdocs: store.entries.map(e => ({ thing: e.thing, name: e.name, version: e.jdoc.doc_version })) },
          robot: {
            connected: robot.isConnected, error: robot.lastErr, info: robot.info,
            version: robot.version, battery: robot.battery,
            cloudAgeMs: deps.cloudSeen ? (Date.now() - (deps.cloudSeen() || 0)) : null
          }
        });
      }

      if (path === '/api/state') return json(res, 200, { state: robot.state, battery: robot.battery, version: robot.version });

      if (path === '/api/settings' && method === 'GET') {
        try {
          const r = await robot.getSettings();
          return json(res, 200, { ok: true, source: 'robot', version: r.version, settings: r.settings });
        } catch (e) {
          const entry: any = store.entries.find((x: any) => /RobotSettings$/.test(String(x.name)));
          if (entry) {
            try {
              return json(res, 200, { ok: true, source: 'jdocs', version: Number(entry.jdoc.doc_version ?? 0), settings: JSON.parse(entry.jdoc.json_doc), warning: (e as Error).message });
            } catch { /* ignore */ }
          }
          return json(res, 200, { ok: false, error: (e as Error).message, settings: null });
        }
      }

      if (path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
          'access-control-allow-origin': '*'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (path === '/api/rules' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          items: deps.rules?.list() ?? [],
          events: RULE_EVENTS.map(e => ({ key: e, label: RULE_EVENT_LABELS[e] }))
        });
      }

      if (path === '/api/robot/animations') {
        // 固件的 anim_manifest.json 才是权威清单（ListAnimations 会超时，也会抓不全），
        // 所以只要配对时从机器人身上取到过清单，就以它为准，不再现场问机器人。
        const cacheFile = join(deps.rootDir, 'data', 'animations.json');
        let cached: any = null;
        try { cached = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* ignore */ }
        const cachedNames: string[] = Array.isArray(cached?.animations) ? cached.animations : [];
        const fromCache = (extra: Record<string, unknown> = {}) => json(res, 200, {
          count: cachedNames.length, animations: cachedNames, lengths: cached?.lengths ?? {},
          source: String(cached?.source ?? 'robot'),
          verified: Array.isArray(cached?.verified) ? cached.verified : cachedNames,
          unverified: Array.isArray(cached?.unverified) ? cached.unverified : [],
          ...extra
        });
        if (/^(robot|manifest)/.test(String(cached?.source ?? '')) && cachedNames.length) return fromCache();
        try {
          let list: string[] = [];
          try {
            list = await robot.listAnimations();
          } catch {
            await new Promise<void>(r => setTimeout(r, 700));
            list = await robot.listAnimations();
          }
          if (!list.length) throw new Error('机器人返回的动画表是空的');
          try { writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), source: 'live', animations: list })); } catch { /* ignore */ }
          return json(res, 200, { count: list.length, animations: list, source: 'live' });
        } catch (e) {
          if (cachedNames.length) return fromCache({ cached: true, warning: '动画表这次没读到，先用上次的：' + (e as Error).message });
          return json(res, 502, { ok: false, error: '动画表读取失败：' + (e as Error).message });
        }
      }

      if (path === '/api/robot/triggers') {
        // 触发器是「一组动画的入口」，比单个动画更像一个行为（发牌、跳舞、打招呼）。
        // ListAnimationTriggers 在 3.x 上很稳，第一次拿到就落盘，之后直接用缓存。
        const cacheFile = join(deps.rootDir, 'data', 'triggers.json');
        let cached: any = null;
        try { cached = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* ignore */ }
        const fromCache = (extra: Record<string, unknown> = {}) => json(res, 200, {
          count: (cached?.triggers ?? []).length, triggers: cached?.triggers ?? [], source: 'cache', ...extra
        });
        if (String(cached?.source ?? '') === 'robot' && !url.searchParams.get('refresh')) return fromCache();
        try {
          const list = await robot.listAnimationTriggers();
          if (!list.length) throw new Error('机器人返回的触发器表是空的');
          try { writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), source: 'robot', triggers: list })); } catch { /* ignore */ }
          return json(res, 200, { count: list.length, triggers: list, source: 'robot' });
        } catch (e) {
          if (cached?.triggers?.length) return fromCache({ warning: '这次没读到，先用上次的：' + (e as Error).message });
          return json(res, 502, { ok: false, error: '触发器表读取失败：' + (e as Error).message });
        }
      }

      if (path.startsWith('/api/program')) {
        if (path === '/api/program/run' && method === 'POST') {
          const body = await readBody(req);
          const steps = Array.isArray(body.steps) ? body.steps : [];
          const loops = Math.min(Math.max(Number(body.loops ?? 1), 1), 20);
          if (deps.rules && !deps.rules.tryAcquire()) {
            return json(res, 409, { ok: false, error: '它正在执行「当……就……」的反应，等两秒再试' });
          }
          const myToken = runToken;
          const out = await (async () => {
            try {
              return await runSteps(robot, deps.rootDir, steps, loops, {
                control: String(body.control ?? 'on') !== 'off',
                isAborted: () => runToken !== myToken,
                maxMs: Number(body.maxMs ?? 240000)
              });
            } finally {
              deps.rules?.release();
            }
          })();
          deps.activity?.append(
            'program',
            (out.ok ? '自己编了一段 ' : '试了一段 ') + steps.length + ' 步的程序' + (out.ok ? '，跑完了' : '，没跑完'),
            { ok: out.ok, ms: out.ms, steps: steps.length, aborted: !!out.aborted }
          );
          return json(res, 200, out);
        }
        if (path === '/api/program/stop' && method === 'POST') {
          runToken++;
          const out = await robot.stopAll().catch((e: Error) => ({ error: e.message }));
          return json(res, 200, { ok: true, stopped: true, out });
        }
        return json(res, 404, { error: 'unknown program endpoint' });
      }

      if (path === '/api/voice/state') {
        return json(res, 200, {
          enabled: deps.voice?.enabled ?? false,
          sttReady: deps.voice?.sttReady ?? false,
          model: deps.voice?.sttModel ?? '',
          busy: deps.voice?.busy ?? false,
          triggers: deps.voice?.triggers ?? [],
          lastHeard: deps.voice?.lastHeard ?? null,
          history: deps.voice?.history ?? []
        });
      }

      if (path === '/api/robot/voices') {
        return json(res, 200, { voices: await listVoices() });
      }

      if (path === '/api/photos' && method === 'GET') {
        const items = deps.photos ? deps.photos.list(Number(url.searchParams.get('limit') ?? 60)) : [];
        return json(res, 200, { ok: true, items: items.map(i => ({ ...i, url: '/api/photos/' + encodeURIComponent(i.name) })) });
      }

      if (path.startsWith('/api/photos/') && method === 'GET') {
        const name = decodeURIComponent(path.slice('/api/photos/'.length));
        const buf = deps.photos ? deps.photos.read(name) : null;
        if (!buf) return json(res, 404, { error: '没有这张照片' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'max-age=3600' });
        return res.end(buf);
      }

      if (path.startsWith('/api/photos/') && method === 'DELETE') {
        const name = decodeURIComponent(path.slice('/api/photos/'.length));
        const ok = deps.photos ? deps.photos.remove(name) : false;
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这张照片' });
      }

      if (path === '/api/robot/image') {
        const buf = await robot.captureImageAwake();
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'access-control-allow-origin': '*' });
        return res.end(buf);
      }

      if (method === 'POST') {
        const body = await readBody(req);
        switch (path) {
          case '/api/rules': {
            if (!deps.rules) return json(res, 500, { ok: false, error: '规则引擎没准备好' });
            const items = deps.rules.replace(body.items ?? body.rules ?? []);
            return json(res, 200, { ok: true, items });
          }
          case '/api/rules/clear': {
            deps.rules?.clear();
            return json(res, 200, { ok: true, items: deps.rules?.list() ?? [] });
          }
          case '/api/rules/test': {
            if (!deps.rules) return json(res, 500, { ok: false, error: '规则引擎没准备好' });
            const ev = String(body.event ?? 'touch');
            const matched = deps.rules.list().filter(r => r.event === ev).length;
            void deps.rules.fire(ev);
            return json(res, 200, { ok: true, event: ev, matched });
          }
          case '/api/robot/photo': {
            const buf = await robot.captureImageAwake();
            if (!deps.photos) return json(res, 500, { ok: false, error: '相册没准备好' });
            const it = deps.photos.save(buf);
            deps.activity?.append('photo', '拍了一张照片，存进相册了');
            return json(res, 200, { ok: true, name: it.name, bytes: it.bytes, url: '/api/photos/' + encodeURIComponent(it.name) });
          }
          case '/api/robot/animation': {
            const name = String(body.name ?? '');
            // 固件不回包，只能按清单里的时长等它跳完，否则界面会在动画中途放开下一条指令。
            let knownMs = 0;
            try {
              const c: any = JSON.parse(readFileSync(join(deps.rootDir, 'data', 'animations.json'), 'utf8'));
              knownMs = Number(c?.lengths?.[name] ?? 0);
            } catch { /* ignore */ }
            const hold = Number(body.holdMs ?? 0) || (knownMs > 0 ? Math.min(knownMs + 300, 20000) : 1500);
            const out = await robot.playAnimation(name, Number(body.loops ?? 1), hold);
            deps.activity?.append('anim', '播放动画 ' + name, { name });
            return json(res, 200, out);
          }
          case '/api/robot/animation-probe': {
            if (!deps.robot) return json(res, 503, { ok: false, error: 'robot not connected' });
            const out = await deps.robot.probeAnimation(String(body.name ?? ''));
            return json(res, 200, out);
          }
          case '/api/robot/animation-trigger': {
            const name = String(body.name ?? '');
            const out = await robot.playAnimationTrigger(name, Number(body.loops ?? 1), Number(body.holdMs ?? 1500));
            return json(res, 200, out);
          }
          case '/api/robot/off-charger': {
            const out = await robot.driveOffCharger();
            if (!out?.already) deps.activity?.append('chargerOff', '自己从充电仓上开下来了');
            return json(res, 200, { ok: true, ...out });
          }
          case '/api/robot/head': return json(res, 200, await robot.moveHeadTo(Number(body.angle ?? 0), Number(body.timeoutMs ?? 7000)));
          case '/api/robot/lift': return json(res, 200, await robot.moveLiftTo(Number(body.height ?? 0), Number(body.timeoutMs ?? 8000)));
          case '/api/robot/head-speed': return json(res, 200, await robot.moveHeadSpeed(Number(body.speed ?? 0)));
          case '/api/robot/lift-speed': return json(res, 200, await robot.moveLiftSpeed(Number(body.speed ?? 0)));
          case '/api/robot/drive': return json(res, 200, await robot.drive(Number(body.left), Number(body.right), Number(body.acc ?? 1400)));
          case '/api/robot/drive-for': {
            const ms = Math.min(Math.max(Number(body.ms ?? 500), 50), 10000);
            return json(res, 200, await robot.driveFor(Number(body.left ?? 0), Number(body.right ?? 0), ms, Number(body.acc ?? 1400)));
          }
          case '/api/robot/stop': return json(res, 200, await robot.stopAll());
          case '/api/robot/eye': return json(res, 200, await robot.setEyeColor(Number(body.hue), Number(body.saturation ?? 1), Number(body.light ?? 0.5)));
          case '/api/robot/volume': return json(res, 200, await robot.setVolume(Number(body.level)));
          case '/api/robot/intent': return json(res, 200, await robot.appIntent(String(body.intent), String(body.param ?? '')));
          case '/api/robot/stream': return json(res, 200, await robot.setImageStreaming(!!body.enable));
          case '/api/robot/say': return json(res, 200, await robot.sayText(String(body.text), !!body.vectorVoice));
          case '/api/robot/speak': {
            // synthesize with Windows SAPI, then push PCM to the robot
            const text = String(body.text ?? '').trim();
            if (!text) return json(res, 400, { error: 'text required' });
            const outPath = join(deps.rootDir, 'logs', 'tts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.wav');
            const t0 = Date.now();
            let wav;
            try {
              await synthesizeToWav(text, outPath, { voice: body.voice, rate: body.rate, volume: 100 });
              wav = parseWav(readFileSync(outPath));
            } finally {
              // 临时 wav 只为喂给解码器，用完就删；以前一直堆在 logs/ 里。
              try { unlinkSync(outPath); } catch { /* ignore */ }
            }
            const rate = Number(body.sampleRate ?? 16000);
            const resampled = resampleLinear(wav.samples, wav.sampleRate, rate);
            const pcm = toPcm16(resampled);
            const play = await robot.streamPcm(pcm, rate, Number(body.volume ?? 90));
            deps.activity?.append('say', '它对你说：「' + text + '」', { chars: text.length });
            return json(res, 200, { ok: true, ms: Date.now() - t0, sourceRate: wav.sampleRate, samples: resampled.length, play });
          }

          case '/api/voice/test': {
            if (!deps.voice) return json(res, 503, { error: 'voice not ready' });
            return json(res, 200, await deps.voice.handleText(String(body.text ?? ''), 'manual'));
          }
          case '/api/voice/enabled': {
            if (!deps.voice) return json(res, 503, { error: 'voice not ready' });
            deps.voice.enabled = !!body.enabled;
            deps.voice.save();
            return json(res, 200, { enabled: deps.voice.enabled });
          }
          case '/api/voice/trigger': {
            if (!deps.voice) return json(res, 503, { error: 'voice not ready' });
            const op = String(body.op ?? 'add');
            if (op === 'add') {
              const phrase = String(body.phrase ?? '').trim();
              const steps = Array.isArray(body.steps) ? body.steps : [];
              if (!phrase || !steps.length) return json(res, 400, { error: 'phrase and steps required' });
              return json(res, 200, { ok: true, trigger: deps.voice.addTrigger(phrase, steps) });
            }
            if (op === 'remove') return json(res, 200, { ok: deps.voice.removeTrigger(String(body.id ?? '')) });
            if (op === 'update') return json(res, 200, { ok: deps.voice.updateTrigger(String(body.id ?? ''), body.patch ?? {}) });
            return json(res, 400, { error: 'unknown op' });
          }
          case '/api/settings': {
            const patch = sanitizeSettings(body.settings ?? body);
            if (!Object.keys(patch).length) return json(res, 400, { error: 'no valid setting fields' });
            try { return json(res, 200, { ok: true, patch, ...(await robot.updateSettings(patch)) }); }
            catch (e) { return json(res, 200, { ok: false, error: (e as Error).message }); }
          }
          case '/api/robot/take-control': return json(res, 200, await robot.takeControl(String(body.priority ?? 'OVERRIDE_BEHAVIORS')));
          case '/api/robot/rpc': {
            const timeout = Math.min(Math.max(Number(body.timeoutMs ?? 10000), 1000), 60000);
            try {
              const result = await robot.call(String(body.method), body.req ?? {}, timeout);
              return json(res, 200, { ok: true, result });
            } catch (e) {
              return json(res, 200, { ok: false, error: (e as Error).message });
            }
          }
          default: return json(res, 404, { error: 'unknown endpoint' });
        }
      }

      // static UI (public/)
      if (method === 'GET' && !path.startsWith('/api/')) {
        const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        const pubDir = join(deps.rootDir, 'public');
        const filePath = join(pubDir, rel);
        // 加分隔符再比，否则 /public2 这类同前缀目录能越界读到外面去
        if (filePath === join(pubDir, 'index.html') || filePath.startsWith(pubDir + sep)) {
          try {
            const buf = readFileSync(filePath);
            const dot = filePath.lastIndexOf('.');
            const types: Record<string, string> = {
              html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
              css: 'text/css; charset=utf-8', png: 'image/png', svg: 'image/svg+xml',
              ico: 'image/x-icon', wav: 'audio/wav', mp3: 'audio/mpeg',
              json: 'application/json; charset=utf-8'
            };
            const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
            res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'content-length': buf.length });
            return res.end(buf);
          } catch { /* fall through */ }
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = (e as Error).message || '失败';
      log.error(`api ${method} ${path}: ${msg}`);
      // 忙 / 掉线属于“等一会儿再点”，不是服务端崩了
      const status = /正在忙|没反应/.test(msg) ? 409 : 500;
      return json(res, status, { ok: false, error: msg });
    }
  });

  const host = deps.host && deps.host.trim() ? deps.host.trim() : '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`控制台端口 ${port} 已被占用：可能 VectorPal 已经开着一个了（任务管理器里看看 node.exe），`
          + `或者改 config.json 里的 apiPort。`));
        return;
      }
      reject(e);
    });
    server.listen(port, host, () => {
      log.info(`console API listening on http://${host}:${port}` + (deps.pin ? ' (pin required for non-local clients)' : ''));
      resolve();
    });
  });
}