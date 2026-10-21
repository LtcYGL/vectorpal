import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Logger } from '../pod/logger.ts';

export interface RobotInfo {
  esn: string;
  ip: string;
  guid: string;
}

export interface LiveState {
  ts: number;
  pose: { x: number; y: number; z: number; yaw: number };
  headAngleRad: number;
  liftHeightMm: number;
  leftWheelMmps: number;
  rightWheelMmps: number;
  status: number;
  onCharger: boolean;
  charging: boolean;
  pickedUp: boolean;
  beingHeld: boolean;
  cliffDetected: boolean;
  buttonPressed: boolean;
  animating: boolean;
  moving: boolean;
  touch: { raw: number; touched: boolean };
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
  proxMm: number;
  stim: { value: number; velocity: number; accel: number; events: string[] };
}

const STATUS_BITS: Record<string, number> = {
  moving: 0x1, carryingBlock: 0x2, pickingOrPlacing: 0x4, pickedUp: 0x8,
  buttonPressed: 0x10, falling: 0x20, animating: 0x40, pathing: 0x80,
  liftInPos: 0x100, headInPos: 0x200, calmPowerMode: 0x400,
  onCharger: 0x1000, charging: 0x2000, cliffDetected: 0x4000,
  wheelsMoving: 0x8000, beingHeld: 0x10000, motionDetected: 0x20000
};

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class RobotBridge extends EventEmitter {
  private log: Logger;
  private protoMod: any = null;
  private client: any = null;
  private md: grpc.Metadata | null = null;
  private stream: any = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  info: RobotInfo | null = null;
  state: LiveState | null = null;
  battery: { level: number; volts: number; charging: boolean; onCharger: boolean } | null = null;
  version: { os: string; engine: string } | null = null;
  private animations: string[] | null = null;
  private controlStream: any = null;
  private lastError = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private batteryTick = 0;
  private failCount = 0;
  private creds: grpc.ChannelCredentials | null = null;
  private robotCertPath = '';
  // 同一时刻只跑一个“动作类”指令，避免连点时几路 MoveHead/DriveWheels 一起灌给机器人
  private motionBusy: string | null = null;

  private role: string;

  constructor(role: string, log: Logger) {
    super();
    this.role = role;
    this.log = log;
  }

  private loadProto(protoDir: string): any {
    if (this.protoMod) return this.protoMod;
    const dir = join(protoDir, 'vector');
    const def = protoLoader.loadSync(join(dir, 'external_interface.proto'), {
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
      includeDirs: [dir, protoDir]
    });
    const loaded: any = grpc.loadPackageDefinition(def);
    this.protoMod = loaded.Anki.Vector.external_interface.ExternalInterface;
    return this.protoMod;
  }

  get isConnected(): boolean { return this.connected; }
  get lastErr(): string { return this.lastError; }

  async connect(info: RobotInfo, protoDir: string, robotCertPath: string): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.info = info;
      const SV = this.loadProto(protoDir);
      const ca = readFileSync(robotCertPath);
      const creds = grpc.credentials.createSsl(ca);
      this.creds = creds;
      this.robotCertPath = robotCertPath;
      this.failCount = 0;
      this.client = new SV(info.ip + ':443', creds, { 'grpc.ssl_target_name_override': 'Vector-M5X2' });
      this.md = new grpc.Metadata();
      this.md.add('authorization', 'Bearer ' + info.guid);
      this.connected = true;
      this.emit('connected');
      await this.refreshIdentity();
      this.openEventStream();
      this.startWatchdog();
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async refreshIdentity(): Promise<void> {
    try {
      const v = await this.call('VersionState', {}, 8000);
      this.version = { os: v.os_version ?? '', engine: String(v.engine_build_id ?? '') };
    } catch (e) { this.log.error('VersionState failed: ' + (e as Error).message); }
    try {
      const b = await this.call('BatteryState', {}, 8000);
      this.battery = {
        level: b.battery_level, volts: b.battery_volts,
        charging: !!b.is_charging, onCharger: !!b.is_on_charger_platform
      };
    } catch (e) { this.log.error('BatteryState failed: ' + (e as Error).message); }
  }

  /**
   * 事件流是 14Hz 的：超过 30 秒一个事件都没有，说明连接看着还在、其实已经僵死
   * （机器人重启时常见），要主动断开重连，否则界面一直显示在线、点什么都没反应。
   * 顺手每 60 秒刷一次电量，否则总览页的电量会一直停在连接那一刻。
   */
  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.connected) return;
      if (this.state && this.stateAgeMs > 30000) {
        this.log.error('event stream silent for ' + Math.round(this.stateAgeMs / 1000) + 's, reconnecting');
        this.markOffline();
        this.scheduleReconnect();
        return;
      }
      if (++this.batteryTick % 4 === 0) void this.refreshBattery();
    }, 15000);
    this.watchdog.unref?.();
  }

  private async refreshBattery(): Promise<void> {
    try {
      const b = await this.call('BatteryState', {}, 5000);
      this.battery = {
        level: b.battery_level, volts: b.battery_volts,
        charging: !!b.is_charging, onCharger: !!b.is_on_charger_platform
      };
    } catch { /* 掉线时不用管，重连后会重新抓一次 */ }
  }

  call(method: string, req: any, timeoutMs = 15000): Promise<any> {
    const c = this.client;
    const md = this.md;
    if (!c) return Promise.reject(new Error('robot not connected'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(method + ' timeout')), timeoutMs);
      (c as any)[method](req, md, (err: any, resp: any) => {
        clearTimeout(t);
        if (err) return reject(new Error(method + ': ' + err.message));
        resolve(resp);
      });
    });
  }

  /** 机器人事件流多久没更新了（毫秒）。用来判断它是不是掉线/在重启。 */
  get stateAgeMs(): number { return this.state ? Date.now() - this.state.ts : Infinity; }

  /**
   * 动作类指令串行执行：连点按钮时后来的人等前面那个跑完，
   * 等太久就回一句人话，而不是几路 MoveHead 一起灌进去把机器人搞懵。
   */
  private async runExclusive<T>(label: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    while (this.motionBusy) {
      if (Date.now() - start > waitMs) throw new Error('它正在忙上一个动作，等一两秒再点');
      await delay(100);
    }
    this.motionBusy = label;
    try {
      await this.ensureAlive();
      return await fn();
    } finally {
      this.motionBusy = null;
      this.scheduleRelease();
    }
  }

  /** 事件流停了就先用一次普通 RPC 探活，探不通直接给一句人话，别让界面干等十几秒。 */
  private async ensureAlive(): Promise<void> {
    if (this.stateAgeMs < 3000) return;
    try {
      await this.call('VersionState', {}, 3000);
    } catch {
      throw new Error('机器人没反应（可能关机了或在重启），等它连上再试');
    }
  }

  openEventStream(): void {
    if (!this.client) return;
    try { this.stream?.cancel?.(); } catch { /* ignore */ }
    const stream = this.client.EventStream({}, this.md);
    this.stream = stream;
    stream.on('data', (msg: any) => {
      if (!this.connected) {
        this.connected = true;
        this.failCount = 0;
        this.log.info('robot back online');
        this.emit('connected');
      }
      this.onEvent(msg);
    });
    stream.on('error', (e: Error) => {
      this.log.error('event stream error: ' + e.message);
      this.markOffline();
      this.scheduleReconnect();
    });
    stream.on('end', () => {
      this.log.info('event stream ended');
      this.markOffline();
      this.scheduleReconnect();
    });
    this.log.info('event stream opened');
  }

  private markOffline(): void {
    if (!this.connected) return;
    this.connected = false;
    this.controlReady = false;
    this.log.info('robot offline');
    this.emit('disconnected');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.info) return;
    this.failCount++;
    // 机器人重启时 :443 会关几分钟：一直重试，但间隔放缓，并定期重建 gRPC 通道
    const wait = Math.min(3000 * this.failCount, 10000);
    if (this.failCount % 10 === 0) this.rebuildClient();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.log.info('reopening event stream');
      this.openEventStream();
    }, wait);
  }

  /**
   * 机器人重新配对后，Bearer 令牌（GUID）会变成本机新发的那把 ——
   * 不用重连，换掉 metadata 就行，下一条 RPC 就带着新令牌走。
   */
  updateAuth(guid: string): void {
    if (!guid) return;
    if (this.info) this.info.guid = guid;
    this.md = new grpc.Metadata();
    this.md.add('authorization', 'Bearer ' + guid);
    this.log.info('robot auth token updated');
  }

  /** 断掉当前通道（配对后机器人换了证书/令牌，必须重新连一次） */
  reset(): void {
    try { this.stream?.cancel?.(); } catch { /* ignore */ }
    try { this.client?.close?.(); } catch { /* ignore */ }
    this.stream = null;
    this.client = null;
    this.connected = false;
  }

  private rebuildClient(): void {
    const SV = this.protoMod;
    if (!SV || !this.info || !this.creds) return;
    this.log.info('rebuilding gRPC channel');
    try { this.stream?.cancel?.(); } catch { /* ignore */ }
    try { this.client?.close?.(); } catch { /* ignore */ }
    this.stream = null;
    this.client = new SV(this.info.ip + ':443', this.creds, { 'grpc.ssl_target_name_override': 'Vector-M5X2' });
  }

  private onEvent(msg: any): void {
    const ev = msg?.event;
    if (!ev) return;
    const kind = ev.event_type;
    if (kind === 'robot_state') {
      const s = ev.robot_state ?? {};
      const pose = s.pose ?? {};
      const q0 = Number(pose.q0 ?? 0), q3 = Number(pose.q3 ?? 0);
      const st = Number(s.status ?? 0);
      const prev = this.state;
      this.state = {
        ts: Date.now(),
        pose: { x: Number(pose.x ?? 0), y: Number(pose.y ?? 0), z: Number(pose.z ?? 0), yaw: Math.atan2(2 * q0 * q3, 1 - 2 * q3 * q3) },
        headAngleRad: Number(s.head_angle_rad ?? 0),
        liftHeightMm: Number(s.lift_height_mm ?? 0),
        leftWheelMmps: Number(s.left_wheel_speed_mmps ?? 0),
        rightWheelMmps: Number(s.right_wheel_speed_mmps ?? 0),
        status: st,
        onCharger: (st & STATUS_BITS.onCharger) !== 0,
        charging: (st & STATUS_BITS.charging) !== 0,
        pickedUp: (st & STATUS_BITS.pickedUp) !== 0,
        beingHeld: (st & STATUS_BITS.beingHeld) !== 0,
        cliffDetected: (st & STATUS_BITS.cliffDetected) !== 0,
        buttonPressed: (st & STATUS_BITS.buttonPressed) !== 0,
        animating: (st & STATUS_BITS.animating) !== 0,
        moving: (st & STATUS_BITS.moving) !== 0,
        touch: { raw: Number(s.touch_data?.raw_touch_value ?? 0), touched: !!s.touch_data?.is_being_touched },
        accel: { x: Number(s.accel?.x ?? 0), y: Number(s.accel?.y ?? 0), z: Number(s.accel?.z ?? 0) },
        gyro: { x: Number(s.gyro?.x ?? 0), y: Number(s.gyro?.y ?? 0), z: Number(s.gyro?.z ?? 0) },
        proxMm: Number(s.prox_data?.distance_mm ?? 0),
        stim: this.state?.stim ?? { value: 0, velocity: 0, accel: 0, events: [] }
      };
      if (prev) {
        if (prev.touch.touched !== this.state.touch.touched) this.emit('touch', this.state.touch);
        if (prev.pickedUp !== this.state.pickedUp) this.emit('pickedUp', this.state.pickedUp);
        if (prev.onCharger !== this.state.onCharger) this.emit('charger', this.state.onCharger);
        if (prev.cliffDetected !== this.state.cliffDetected) this.emit('cliff', this.state.cliffDetected);
        if (prev.buttonPressed !== this.state.buttonPressed) this.emit('button', this.state.buttonPressed);
      }
      this.emit('state', this.state);
      return;
    }
    if (kind === 'stimulation_info') {
      const si = ev.stimulation_info ?? {};
      const stim = {
        value: Number(si.value ?? 0), velocity: Number(si.velocity ?? 0), accel: Number(si.accel ?? 0),
        events: (si.emotion_events ?? []).map((e: any) => String(e))
      };
      if (this.state) this.state.stim = stim;
      this.emit('stim', stim);
      return;
    }
    if (kind === 'connection_response') {
      this.emit('connection', ev.connection_response);
      return;
    }
    this.emit('event', { kind, raw: ev });
  }

  async listAnimations(): Promise<string[]> {
    if (this.animations) return this.animations;
    const r = await this.call('ListAnimations', {}, 25000);
    const raw = r.animation_names ?? [];
    const names: string[] = raw.map((x: any) => (typeof x === 'string' ? x : String(x?.name ?? ''))).filter((s: string) => s);
    this.animations = names.sort();
    return this.animations;
  }

  /** 触发器清单：3.x 上 ListAnimationTriggers 很稳（ListAnimations 会超时），一次回 479 个。
   *  触发器是「一组动画的入口」，比单个动画更接近「行为」。 */
  async listAnimationTriggers(): Promise<string[]> {
    if (this.triggers) return this.triggers;
    const r = await this.call('ListAnimationTriggers', {}, 8000);
    const raw = r?.animation_trigger_names ?? [];
    const names: string[] = raw.map((x: any) => (typeof x === 'string' ? x : String(x?.name ?? ''))).filter((s: string) => s);
    this.triggers = names.sort();
    return this.triggers;
  }

  private triggers: string[] | null = null;
  private controlReady = false;
  private releaseTimer: any = null;

  async ensureControl(): Promise<void> {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (this.controlReady && this.controlStream) return;
    try {
      await this.takeControl('OVERRIDE_BEHAVIORS', 4000);
      this.controlReady = true;
      this.log.info('behavior control acquired');
    } catch (e) {
      this.controlReady = false;
      this.log.error('ensureControl failed: ' + (e as Error).message);
    }
  }

  /** 动作做完几秒后把控制权还给机器人，否则它一直处于「被接管」状态，连唤醒词都不应。 */
  private scheduleRelease(delayMs = 3000): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.motionBusy) void this.releaseControl();
    }, delayMs);
  }

  async releaseControl(): Promise<void> {
    const stream: any = this.controlStream;
    this.controlReady = false;
    this.controlStream = null;
    if (!stream) return;
    try { stream.write({ control_release: {} }); } catch { /* ignore */ }
    try { stream.end(); } catch { /* ignore */ }
    this.log.info('behavior control released');
  }

  async takeControl(priority = 'OVERRIDE_BEHAVIORS', timeoutMs = 6000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      const stream = this.client.BehaviorControl(this.md);
      const timer = setTimeout(() => {
        // 超时就把这条流关掉，否则它会一直挂在机器人上，下次 ensureControl 还会以为控制权在手里
        try { stream.cancel?.(); } catch { /* ignore */ }
        try { stream.end(); } catch { /* ignore */ }
        if (this.controlStream === stream) { this.controlStream = null; this.controlReady = false; }
        reject(new Error('BehaviorControl: no grant response in ' + timeoutMs + 'ms'));
      }, timeoutMs);
      let settled = false;
      const done = (err: Error | null, val?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      stream.on('data', (d: any) => {
        const granted = d?.control_granted_response ?? d?.controlGrantedResponse;
        if (granted) {
          this.log.info('behavior control: ' + JSON.stringify(granted));
          // 固件回的 ControlGrantedResponse 常是空 message（status 全是默认值），
          // 直接把它当结果返回就变成 {}，调用方看不出到底成没成，这里补个明确的 granted。
          done(null, { granted: true, detail: granted });
        }
      });
      stream.on('error', (e: Error) => { this.controlReady = false; done(e); });
      stream.on('end', () => { this.controlReady = false; });
      stream.write({ control_request: { priority } });
      this.controlStream = stream;
    });
  }

  /**
   * 3.x 固件里 PlayAnimation / PlayAnimationTrigger 收到合法请求后**不回响应**
   * （动画确实会播，RPC 却挂到超时），所以当成"发射后不管"：发出、最多等 1.2 秒确认回包。
   * 注意请求体是**嵌套消息**：{ animation: { name } } / { animation_trigger: { name } }。
   * 3.x 的 proto 把 2.0 时代的 animation_name 字段换成了 Animation 消息，
   * 继续按老字段发，引擎收到的是空名字 → 日志 AnimNotFound、机器人什么都不做。
   */
  private async fireAndForget(method: string, req: any, waitMs = 1200): Promise<any> {
    if (!this.client) throw new Error('robot not connected');
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
      const t = setTimeout(() => finish({ sent: true }), waitMs);
      try {
        (this.client as any)[method](req, this.md, { deadline: Date.now() + 20000 }, (err: any, res: any) => {
          clearTimeout(t);
          finish(err && !res ? { sent: true, late_error: err.message } : (res ?? { sent: true }));
        });
      } catch (e) {
        clearTimeout(t);
        finish({ sent: true, late_error: (e as Error).message });
      }
    });
  }

  /** 站在充电仓上时固件会忽略所有外部马达指令（引擎日志：external motor commands are not allowed），
   *  调用只会「受理成功但实际不动」，所以先给一句人话，别让界面假死。 */
  private ensureOffCharger(what: string): void {
    if (this.state?.onCharger) {
      throw new Error('它现在站在充电仓上，固件会忽略所有外部动作指令，' + what + '做不了，先把它抱下来再试');
    }
  }

  /** 只问「固件认不认这个名字」：发出后 250ms 就返回，不占动作互斥、不等动画时长。
   *  引擎收到不存在的名字会立刻回包并记 AnimNotFound，判定靠机器人日志配对。 */
  async probeAnimation(name: string): Promise<any> {
    return this.fireAndForget('PlayAnimation', { animation: { name }, loops: 1 }, 250);
  }

  async playAnimation(name: string, loops = 1, holdMs = 1500): Promise<any> {
    this.ensureOffCharger('动画');
    return this.runExclusive('anim', 3000, async () => {
      // 必须先攥住行为控制：不持控制时引擎正跑自主动作，PlayAnimation 会被直接丢掉，
      // 日志里连 "Received rpc request PlayAnimation" 都不出现，界面看起来就是点了没反应。
      await this.ensureControl();
      const out = await this.fireAndForget('PlayAnimation', { animation: { name }, loops });
      await delay(Math.max(0, Math.min(8000, holdMs)));
      this.scheduleRelease();
      return out;
    });
  }

  async playAnimationTrigger(name: string, loops = 1, holdMs = 1500): Promise<any> {
    this.ensureOffCharger('动画');
    return this.runExclusive('anim', 3000, async () => {
      await this.ensureControl();
      const out = await this.fireAndForget('PlayAnimationTrigger', { animation_trigger: { name }, loops });
      await delay(Math.max(0, Math.min(8000, holdMs)));
      this.scheduleRelease();
      return out;
    });
  }

  /** 让它自己从充电仓上开下来。 */
  async driveOffCharger(): Promise<any> {
    if (!this.state?.onCharger) return { already: true };
    return this.runExclusive('offCharger', 5000, () => this.call('DriveOffCharger', {}, 30000));
  }
  // MoveHead/MoveLift only take a speed (proto field 1 = speed_rad_per_sec, continuous motion).
  async moveHeadSpeed(speedRadPerSec: number): Promise<any> {
    return this.call('MoveHead', { speed_rad_per_sec: speedRadPerSec }, 8000);
  }
  async moveLiftSpeed(speedRadPerSec: number): Promise<any> {
    return this.call('MoveLift', { speed_rad_per_sec: speedRadPerSec }, 8000);
  }
  async moveHeadTo(angleRad: number, timeoutMs = 7000): Promise<any> {
    this.ensureOffCharger('抬头低头');
    return this.runExclusive('head', 3000, async () => {
      await this.ensureControl();
      const start = Date.now();
      let lastCur = this.state?.headAngleRad ?? 0;
      let lastMove = Date.now();
      while (Date.now() - start < timeoutMs) {
        const cur = this.state?.headAngleRad ?? 0;
        const err = angleRad - cur;
        if (Math.abs(err) < 0.04) break;
        // 控制权有时会被固件悄悄收回（比如刚 DriveWheels 完），表现为指令发了但头不动。
        // 一秒半没进展就重新要一次控制，而不是干等到超时。
        if (Math.abs(cur - lastCur) > 0.03) { lastCur = cur; lastMove = Date.now(); }
        else if (Date.now() - lastMove > 1500) {
          this.controlReady = false;
          await this.ensureControl();
          lastCur = cur;
          lastMove = Date.now();
        }
        const speed = Math.max(0.25, Math.min(1.2, Math.abs(err) * 6)) * Math.sign(err);
        await this.moveHeadSpeed(speed).catch(() => {});
        await delay(110);
      }
      await this.moveHeadSpeed(0).catch(() => {});
      return { headAngleRad: this.state?.headAngleRad ?? null };
    });
  }
  async moveLiftTo(heightMm: number, timeoutMs = 8000): Promise<any> {
    this.ensureOffCharger('升举机械臂');
    return this.runExclusive('lift', 3000, async () => {
      await this.ensureControl();
      const MM_PER_RAD_S = 78; // measured: 1.0 rad/s on the lift ~= 78 mm/s
      const start = Date.now();
      let lastCur = this.state?.liftHeightMm ?? 0;
      let lastMove = Date.now();
      while (Date.now() - start < timeoutMs) {
        const cur = this.state?.liftHeightMm ?? 0;
        const err = heightMm - cur;
        if (Math.abs(err) < 3) break;
        if (Math.abs(cur - lastCur) > 2) { lastCur = cur; lastMove = Date.now(); }
        else if (Date.now() - lastMove > 1500) {
          this.controlReady = false;
          await this.ensureControl();
          lastCur = cur;
          lastMove = Date.now();
        }
        const speed = Math.max(0.12, Math.min(1.4, (Math.abs(err) / MM_PER_RAD_S) * 4)) * Math.sign(err);
        await this.moveLiftSpeed(speed).catch(() => {});
        await delay(110);
      }
      await this.moveLiftSpeed(0).catch(() => {});
      return { liftHeightMm: this.state?.liftHeightMm ?? null };
    });
  }
  // DriveWheels must be re-sent frequently; firmware drops one-shot commands.
  async driveFor(leftMmps: number, rightMmps: number, durationMs: number, acc = 1400): Promise<any> {
    this.ensureOffCharger('走动');
    return this.runExclusive('drive', 5000, async () => {
      await this.ensureControl();
      const start = Date.now();
      while (Date.now() - start < durationMs) {
        if (this.state?.cliffDetected) { await this.stopAll().catch(() => {}); break; }
        await this.drive(leftMmps, rightMmps, acc).catch(() => {});
        await delay(60);
      }
      await this.stopAll().catch(() => {});
      return { pose: this.state?.pose ?? null };
    });
  }
  async drive(left: number, right: number, acc = 1400): Promise<any> {
    this.ensureOffCharger('走轮子');
    return this.call('DriveWheels', { left_wheel_mmps: left, right_wheel_mmps: right, left_wheel_mmps2: acc, right_wheel_mmps2: acc });
  }
  async stopAll(): Promise<any> { return this.call('StopAllMotors', {}); }
  async setEyeColor(hue: number, saturation = 1, light = 0.5): Promise<any> {
    return this.call('SetEyeColor', { hue, saturation, light });
  }
  async setVolume(level: number): Promise<any> { return this.call('SetMasterVolume', { volume_level: level }); }

  /** Read the robot-local settings jdoc and return it as a plain object. */
  async getSettings(): Promise<any> {
    const r = await this.call('PullJdocs', { jdoc_types: ['ROBOT_SETTINGS'] }, 10000);
    const doc = r?.named_jdocs?.[0]?.doc;
    if (!doc?.json_doc) throw new Error('robot returned no RobotSettings jdoc');
    return { version: Number(doc.doc_version ?? 0), settings: JSON.parse(doc.json_doc) };
  }

  /** Write a partial RobotSettingsConfig. Every field is its own protobuf oneof. */
  async updateSettings(patch: Record<string, unknown>): Promise<any> {
    const r = await this.call('UpdateSettings', { settings: patch }, 15000);
    const doc = r?.doc;
    let settings: any = null;
    if (doc?.json_doc) { try { settings = JSON.parse(doc.json_doc); } catch { settings = null; } }
    return { code: r?.code ?? null, version: Number(doc?.doc_version ?? 0), settings, accepted: (r?.code ?? '') === 'SETTINGS_ACCEPTED' };
  }
  async captureImage(): Promise<Buffer> {
    const r = await this.call('CaptureSingleImage', {}, 20000);
    return Buffer.from(r.data ?? []);
  }

  /**
   * 拍照。机器人睡着（或者摄像头没被唤醒）时 CaptureSingleImage 会直接超时，
   * 所以失败一次就先用 AppIntent 把它“叫醒”（lookatme），等一小会儿再拍。
   */
  async captureImageAwake(): Promise<Buffer> {
    try {
      const buf = await this.captureImage();
      if (buf.length > 100) return buf;
    } catch { /* 下面叫醒再试 */ }
    try { await this.appIntent('intent_imperative_lookatme'); } catch { /* ignore */ }
    await new Promise<void>(r => setTimeout(r, 1500));
    return this.captureImage();
  }
  async setImageStreaming(enable: boolean): Promise<any> {
    return this.call('EnableImageStreaming', { enable });
  }
  async appIntent(intent: string, param = ''): Promise<any> {
    return this.call('AppIntent', { intent, param });
  }
  /** Push 16-bit mono PCM to the robot's speaker. Handles prepare/chunk/complete framing. */
  async streamPcm(pcm: Buffer, sampleRate = 16000, volume = 90, timeoutMs = 120000): Promise<any> {
    // 等「播完」的最长时间不能是固定两分钟：机器人偶尔不回 playback_complete，
    // 那样会把动作通道锁死两分钟（后面点什么都是「正在忙」）。按音频时长 + 5 秒兜底。
    const audioMs = Math.round((pcm.length / 2 / sampleRate) * 1000);
    const waitMs = Math.min(timeoutMs, audioMs + 5000);
    return this.runExclusive('speak', 20000, async () => {
      if (!this.client) throw new Error('robot not connected');
      await this.ensureControl();
      const stream = this.client.ExternalAudioStreamPlayback(this.md);
      const finished = new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ waited: true, ended: false }), waitMs);
        stream.on('data', (d: any) => {
          if (d?.audio_stream_playback_complete ?? d?.audioStreamPlaybackComplete) { clearTimeout(t); resolve(d); }
        });
        stream.on('error', (e: Error) => { clearTimeout(t); reject(e); });
        stream.on('end', () => { clearTimeout(t); resolve({ ended: true }); });
      });
      stream.write({ audio_stream_prepare: { audio_frame_rate: Math.round(sampleRate), audio_volume: Math.max(0, Math.min(100, Math.round(volume))) } });
      const CHUNK = 1024;
      // 节奏按“这块音频本身有多长”算（1024B@16k = 32ms）。原来固定 55ms，
      // 每块慢 23ms，长句会在中间一顿一顿甚至被机器人当成说完了。
      const paceMs = Math.max(10, Math.round((CHUNK / 2 / sampleRate) * 1000 * 0.85));
      for (let i = 0; i < pcm.length; i += CHUNK) {
        const slice = pcm.subarray(i, Math.min(i + CHUNK, pcm.length));
        if (!stream.write({ audio_stream_chunk: { audio_chunk_size_bytes: slice.length, audio_chunk_samples: slice } })) {
          await new Promise<void>(r => stream.once('drain', () => r()));
        }
        await delay(paceMs);
      }
      stream.write({ audio_stream_complete: {} });
      try {
        return await finished;
      } finally {
        try { stream.end(); } catch { /* ignore */ }
      }
    });
  }

  async sayText(text: string, useVectorVoice = false): Promise<any> {
    return this.call('SayText', { text, use_vector_voice: useVectorVoice }, 20000);
  }
}