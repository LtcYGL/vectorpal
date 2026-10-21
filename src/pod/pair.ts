import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.ts';
import type { JdocsStore } from './store.ts';
import { captureRobotCert } from './robotcert.ts';
import { issueRobotToken } from './token.ts';

/**
 * 接入/配对机器人 —— 逻辑照搬 wire-pod 的「SSH 配对」（setup/ssh.go + setup/certs.go +
 * vector-cloud/pod-bot-install.sh）：
 *
 *   1. root 登录，确认对面是 Vector
 *   2. 判断固件类型：有 /anki/bin/vic-gateway 就是原厂/OSKR，需要换 vic-cloud；
 *      没有就是现代 CFW（WireOS 这类），它自己认 server_config.json
 *   3. 挂载可写、停掉机器人服务
 *   4. 写入 /data/data/server_config.json（把我们自己的地址告诉它）
 *   5. 写入 /data/data/wirepod-cert.crt（让它信我们的 :443 证书）
 *   6. 跑 pod-bot-install.sh：清 token、清 onboarding、重建 robot.pem、重启
 *
 * 机器人重启后会重新进入 onboarding，然后来向我们要 token —— 那一步在 jdocs.ts 的
 * ReadDocs(vic.AppTokens) 里给它发 GUID，配对才算真正完成。
 */

const SSH = process.env.VP_SSH || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';

export interface PairStatus {
  running: boolean;
  ip: string;
  esn: string;
  step: string;
  done: boolean;
  error: string;
  log: string[];
  startedAt: number;
  finishedAt: number;
}

export interface PairOptions {
  rootDir: string;
  store: JdocsStore;
  log: Logger;
  /** 机器人该连的地址/端口（和 pod 的 :443 一致） */
  hostIp: string;
  port: number;
  /** 机器人要信任的证书，就是 pod :443 用的那张 */
  certPath: string;
  onStep?: (s: PairStatus) => void;
}

interface RunResult { code: number; out: string; }

function run(cmd: string, args: string[], stdin?: Buffer, timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    p.on('error', (e: Error) => { clearTimeout(timer); resolve({ code: -1, out: out + String(e.message) }); });
    p.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    if (stdin) { try { p.stdin.write(stdin); } catch { /* ignore */ } }
    try { p.stdin.end(); } catch { /* ignore */ }
  });
}

function sshBase(ip: string, keyPath: string): string[] {
  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'ConnectTimeout=8',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-i', keyPath,
    'root@' + ip
  ];
}

/** Windows 的 ssh 会拒读权限过宽的私钥，这里复制一份并收紧 ACL */
function prepareKey(rootDir: string, keyPem: Buffer, log: Logger): Promise<string> {
  const dir = join(rootDir, 'data', 'keys');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, 'root_key');
  if (existsSync(dst)) {
    const old = readFileSync(dst);
    if (old.equals(keyPem)) return Promise.resolve(dst);
  }
  writeFileSync(dst, keyPem, { mode: 0o600 });
  const user = process.env.USERNAME || '';
  return run('icacls', [dst, '/inheritance:r', '/grant:r', user + ':(R)'], undefined, 15000)
    .then(r => { if (r.code !== 0) log.warn('icacls 收紧密钥权限失败: ' + r.out.trim()); return dst; });
}

export class PairEngine {
  private opts: PairOptions;
  private status: PairStatus = { running: false, ip: '', esn: '', step: 'idle', done: false, error: '', log: [], startedAt: 0, finishedAt: 0 };
  // 配对全程都是同一台机器人、同一把钥匙，存成字段，收尾阶段（读动画清单）才用得到
  private sshIp = '';
  private sshKey = '';

  constructor(opts: PairOptions) {
    this.opts = opts;
  }

  get(): PairStatus { return this.status; }

  private set(patch: Partial<PairStatus>): void {
    this.status = { ...this.status, ...patch };
    try { this.opts.onStep?.(this.status); } catch { /* ignore */ }
  }

  private sh(cmd: string, stdin?: Buffer, timeoutMs?: number) {
    return run(SSH, sshBase(this.sshIp, this.sshKey).concat([cmd]), stdin, timeoutMs);
  }

  private line(msg: string): void {
    const stamp = new Date().toTimeString().slice(0, 8);
    const log = this.status.log.concat([stamp + '  ' + msg]).slice(-120);
    this.set({ log });
    this.opts.log.info('pair: ' + msg);
  }

  /** 开始配对。keyPem 是 SSH 私钥内容（root 的）。 */
  async start(ip: string, keyPem: Buffer): Promise<void> {
    if (this.status.running) throw new Error('上一次接入还没结束，等它跑完');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('机器人 IP 不对：' + ip);
    if (!keyPem || keyPem.length < 100) throw new Error('SSH 私钥内容不对（要 root 的那把，开头是 -----BEGIN）');
    this.status = { running: true, ip, esn: '', step: '准备中', done: false, error: '', log: [], startedAt: Date.now(), finishedAt: 0 };
    this.set({});
    void this.go(ip, keyPem).catch((e: Error) => {
      this.line('失败：' + e.message);
      this.set({ running: false, error: e.message, step: '失败', finishedAt: Date.now() });
    });
  }

  private async go(ip: string, keyPem: Buffer): Promise<void> {
    const { rootDir, store, certPath, hostIp, port } = this.opts;
    const keyPath = await prepareKey(rootDir, keyPem, this.opts.log);
    this.sshIp = ip;
    this.sshKey = keyPath;
    const sh = (cmd: string, stdin?: Buffer, timeoutMs?: number) => this.sh(cmd, stdin, timeoutMs);

    // 1. 确认是 Vector
    this.set({ step: '检查设备' });
    const uname = await sh('uname -a');
    if (!uname.out.includes('Vector')) throw new Error('对面不是 Vector（或 SSH 没登进去）：' + uname.out.trim().slice(0, 200));
    this.line('设备已确认：' + uname.out.trim().split('\n')[0]);

    // 2. 固件类型（wire-pod 的判据：/anki/bin/vic-gateway 存在 = 原厂固件，需要换 vic-cloud）
    this.set({ step: '检查固件' });
    const gw = await sh('ls /anki/bin/vic-gateway');
    const modern = gw.code !== 0;
    this.line(modern ? '固件是现代 CFW（自己认 server_config.json，不用换 vic-cloud）' : '固件是原厂/OSKR（要替换 vic-cloud）');

    // 3. 准备要传的文件
    const cfg = {
      jdocs: hostIp + ':' + port,
      tms: hostIp + ':' + port,
      chipper: hostIp + ':' + port,
      check: hostIp + '/ok',
      logfiles: 's3://anki-device-logs-prod/victor',
      appkey: 'oDoa0quieSeir6goowai7f'
    };
    const cfgBuf = Buffer.from(JSON.stringify(cfg), 'utf8');
    const cert = readFileSync(certPath);
    const scriptPath = join(rootDir, 'assets', 'pod-bot-install.sh');
    if (!existsSync(scriptPath)) throw new Error('缺少 assets/pod-bot-install.sh');
    const script = readFileSync(scriptPath);

    // 4. 挂载可写 + 停服务
    this.set({ step: '准备机器人（屏幕会黑一下）' });
    const initCmd = modern
      ? 'mount -o rw,remount,exec /data 2>/dev/null; systemctl stop anki-robot.target mm-anki-camera mm-qcamera-daemon 2>/dev/null; echo ok'
      : 'mount -o rw,remount / 2>/dev/null; mount -o rw,remount,exec /data 2>/dev/null; systemctl stop anki-robot.target mm-anki-camera mm-qcamera-daemon 2>/dev/null; echo ok';
    const init = await sh(initCmd, undefined, 60000);
    this.line('已挂载可写并停掉机器人服务' + (init.code === 0 ? '' : '（返回 ' + init.code + '，继续）'));

    // 5-7. 上传三个文件（走 stdin 重定向，不依赖机器人有 scp/sftp）
    this.set({ step: '写入服务器地址' });
    let r = await sh('cat > /data/data/server_config.json', cfgBuf);
    if (r.code !== 0) throw new Error('写 server_config.json 失败：' + r.out.trim());
    this.line('server_config.json → ' + hostIp + ':' + port);

    this.set({ step: '写入证书' });
    r = await sh('cat > /data/data/wirepod-cert.crt', cert);
    if (r.code !== 0) throw new Error('写 wirepod-cert.crt 失败：' + r.out.trim());
    this.line('wirepod-cert.crt 已写入（' + cert.length + ' 字节）');

    r = await sh('cat > /data/pod-bot-install.sh', script);
    if (r.code !== 0) throw new Error('写 pod-bot-install.sh 失败：' + r.out.trim());
    await sh('chmod 0755 /data/pod-bot-install.sh');
    this.line('安装脚本已就位');

    // 8. 原厂固件：换 vic-cloud（wire-pod 会塞进它自己的 fork）
    if (!modern) {
      const cloudPath = join(rootDir, 'assets', 'vic-cloud');
      if (existsSync(cloudPath)) {
        this.set({ step: '替换 vic-cloud' });
        const cloud = readFileSync(cloudPath);
        const up = await sh('cat > /anki/bin/vic-cloud && chmod 0755 /anki/bin/vic-cloud', cloud, 180000);
        if (up.code !== 0) throw new Error('替换 vic-cloud 失败：' + up.out.trim());
        this.line('vic-cloud 已替换（' + cloud.length + ' 字节）');
      } else {
        this.line('注意：这台是原厂固件，但本地没有 assets/vic-cloud，跳过替换（它可能连不上我们）');
      }
    }

    // 9. 重置证书 + 重启
    this.set({ step: '重置证书并重启（黑屏一分钟是正常的）' });
    const inst = await sh('chmod +rwx /data/data/server_config.json /data/data/wirepod-cert.crt /data/pod-bot-install.sh; /data/pod-bot-install.sh; echo __done__', undefined, 240000);
    this.line('安装脚本执行完毕' + (inst.out.includes('__done__') ? '' : '（没等到收尾标记：' + inst.code + '）'));

    // 10. 脚本把 token.jwt / onboardingState.json 删了，机器人重启会卡在 onboarding。
    //     它读 token 用的是 ParseUnverified（只解 claims、不验签），所以本机现签一张塞回去即可，
    //     不需要 Anki 那台早就停服的账号服务器；onboardingState 直接标成已完成。
    await this.fetchAnimations();

    this.set({ step: '写回令牌（让它跳过 onboarding）' });
    const esn = store.robotByIp(ip)?.esn ?? store.botInfo.robots[0]?.esn ?? '';
    const jwt = issueRobotToken(esn);
    const onboard = JSON.stringify({ onboardingCompletionTime: Math.floor(Date.now() / 1000), onboardingStage: 'Complete' });
    const persistent = '/data/data/com.anki.victor/persistent';
    r = await sh(`mkdir -p ${persistent}/token ${persistent}/onboarding; cat > ${persistent}/token/token.jwt && chmod 0644 ${persistent}/token/token.jwt`, Buffer.from(jwt, 'utf8'));
    if (r.code !== 0) throw new Error('写 token.jwt 失败：' + r.out.trim());
    r = await sh(`cat > ${persistent}/onboarding/onboardingState.json && chmod 0644 ${persistent}/onboarding/onboardingState.json`, Buffer.from(onboard, 'utf8'));
    if (r.code !== 0) throw new Error('写 onboardingState.json 失败：' + r.out.trim());
    this.line('令牌已写好（' + jwt.length + ' 字节），机器人重启后就是已接入状态');

    this.set({ step: '重启机器人' });
    await sh('sync; reboot', undefined, 15000);
    this.line('机器人正在重启（约 40 秒）');

    // 10. 机器人会重建 robot.pem，:443 的证书也跟着换一把 —— 抓回来，否则控制台连不上它
    this.set({ step: '等机器人换好证书' });
    const got = await this.refreshRobotCert(ip);
    if (got) this.line('本机证书已换成机器人现在用的那张（控制台不用动）');

    // 11. 收尾：等机器人以新身份来要 token
    this.set({ step: '等机器人连回来', done: true, running: false, finishedAt: Date.now() });
    this.line('机器人正在重启。它连回来时会自动拿到令牌 —— 看「已接入」列表里出现 ESN 就好了。');
    store.save();
  }

  /** 从机器人身上取一份真实的动画清单：
   *  引擎的 PlayAnimByName 只查 anim_manifest.json 建出来的表，所以 manifest 就是权威名单。
   *  animations 目录里的 .bin 并不代表能不能播（实测 1208 条里只有 311 条在该目录有文件，
   *  照磁盘取交集会把 895 个能播的误删），所以直接照 manifest 写。 */
  private async fetchAnimations(): Promise<void> {
    this.set({ step: '读它的动画清单' });
    try {
      const man = await this.sh('cat /anki/data/assets/cozmo_resources/assets/anim_manifest.json');
      if (man.code !== 0) { this.line('动画清单没读到，先跳过（不影响接入）'); return; }
      let list: any[] = [];
      try { list = JSON.parse(man.out); } catch { list = []; }
      const names: string[] = [];
      const lengths: Record<string, number> = {};
      for (const it of list) {
        const n = String(it?.name ?? '');
        const ms = Number(it?.length_ms ?? 0);
        if (!n) continue;
        names.push(n);
        if (ms > 0) lengths[n] = ms;
      }
      if (!names.length) { this.line('动画清单是空的，先跳过'); return; }
      names.sort();
      writeFileSync(join(this.opts.rootDir, 'data', 'animations.json'), JSON.stringify({ ts: Date.now(), source: 'manifest:robot', animations: names, lengths }));
      this.line('动画清单：' + names.length + ' 个（照固件 anim_manifest.json）');
    } catch (e) {
      this.line('读动画清单出错（不影响接入）：' + (e as Error).message);
    }
  }

  /** 机器人重配后 :443 换成新自签证书，这里轮询抓一份存到 certs/robot.crt */
  private async refreshRobotCert(ip: string): Promise<boolean> {
    const dst = join(this.opts.rootDir, 'certs', 'robot.crt');
    for (let i = 0; i < 40; i++) {
      try {
        const pem = await captureRobotCert(ip, this.opts.port, 4000);
        writeFileSync(dst, pem);
        return true;
      } catch { /* 服务还没起来，继续等 */ }
      await new Promise(r => setTimeout(r, 3000));
    }
    this.line('没抓到机器人的新证书（它还没起来？控制台会在后台自己再试）');
    return false;
  }
}
