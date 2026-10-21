import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { Logger } from './logger.ts';
import { JdocsStore } from './store.ts';
import { buildJdocsService } from './jdocs.ts';
import { buildTokenService } from './token.ts';
import { buildChipperService } from './chipper.ts';
import { startHttp80 } from './http80.ts';
import { startMdns, primaryIPv4 } from './mdns.ts';
import { PairEngine } from './pair.ts';
import { captureRobotCert } from './robotcert.ts';
import { ensureServerCert } from './certgen.ts';
import { RobotBridge } from '../bridge/robot.ts';
import { startApi } from '../api/server.ts';
import { createStt } from '../audio/stt.ts';
import { ActivityLog } from './activity.ts';
import { PhotoStore } from './photos.ts';
import { VoiceService } from '../voice/voice.ts';
import { RulesEngine, RULE_EVENT_LABELS } from '../program/rules.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

const dataDir = join(ROOT, cfg.dataDir ?? 'data');
const certDir = join(ROOT, 'certs');
mkdirSync(dataDir, { recursive: true });

const log = new Logger(join(ROOT, cfg.logDir ?? 'logs'));

// tiny event bus shared by the voice service and the console API (SSE)
const bus: { subs: Set<(t: string, p: unknown) => void>; emit: (t: string, p: unknown) => void } = {
  subs: new Set(),
  emit(t: string, p: unknown) { for (const f of this.subs) { try { f(t, p); } catch { /* ignore */ } } }
};
let voice: VoiceService | null = null;
const store = new JdocsStore(join(dataDir, 'jdocs.json'), join(dataDir, 'botSdkInfo.json'));
const activity = new ActivityLog(join(dataDir, 'activity'), log);
const photos = new PhotoStore(ROOT);

log.info(`vectorpal pod starting (ip=${primaryIPv4()})`);
log.info(`data: ${dataDir}  known bots: [${store.botInfo.robots.map(r => r.esn).join(', ')}]`);

// ---- proto loading -------------------------------------------------------
// google/protobuf/descriptor.proto 随仓库带在 proto/ 下面（extensions.proto 要用），
// 所以不依赖 google-proto-files 这个 78MB 的包，includeDirs 用 proto 自己就够了。
const protoDir = join(ROOT, 'proto');
const packageDef = protoLoader.loadSync(
  ['jdocs.proto', 'token.proto', 'chipperpb.proto'].map(f => join(protoDir, f)),
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir]
  }
);
const proto: any = grpc.loadPackageDefinition(packageDef);
log.info(`protos loaded: ${Object.keys(proto).join(', ')}`);

// ---- grpc server ---------------------------------------------------------
const server = new grpc.Server();
// 新机器人接入时（jdocs 发令牌那一刻）把控制台的 Bearer 换成新 GUID
let robotRef: RobotBridge | null = null;
server.addService(proto.jdocspb.Jdocs.service, buildJdocsService(store, log, (_esn, _ip, guid) => {
  try { robotRef?.updateAuth(guid); } catch { /* ignore */ }
}) as any);
server.addService(proto.tokenpb.Token.service, buildTokenService(store, log) as any);
server.addService(
  proto.chippergrpc2.ChipperGrpc.service,
  buildChipperService(log, (audio, device, encoding) => { void voice?.handlePcm(audio, device, encoding); }) as any
);

function creds(name: string) {
  const cert = readFileSync(join(certDir, `${name}.crt`));
  const key = readFileSync(join(certDir, `${name}.key`));
  return grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }], false);
}

function bind(port: number, certName: string): Promise<void> {
  return new Promise((resolveBind, rejectBind) => {
    server.bindAsync(`0.0.0.0:${port}`, creds(certName), (err, boundPort) => {
      if (err) return rejectBind(new Error(explainBindError(port, err)));
      log.info(`gRPC (jdocs+token+chipper) listening on :${boundPort} [cert ${certName}]`);
      resolveBind();
    });
  });
}

/** 端口被占用是最常见的启动失败原因，给它一句人话解释 */
function explainBindError(port: number, err: Error): string {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (code === 'EADDRINUSE' || /EADDRINUSE|address already in use|已被占用/i.test(err.message)) {
    return `端口 ${port} 已被占用：可能已经有一个 VectorPal 在运行（看看托盘或任务管理器里的 node.exe），`
      + `也可能别的软件占着它。先退出那一个，或改 config.json 里的端口再启动。`;
  }
  if (code === 'EACCES') return `端口 ${port} 需要管理员权限（Windows 一般不会，除非被别的服务保留）。`;
  return `监听端口 ${port} 失败：${err.message}`;
}

async function main(): Promise<void> {
  // 机器人是按 IP 校验 :443 证书的，SAN 里没有当前网卡 IP 会直接握手失败
  ensureServerCert(join(certDir, cfg.cert443 + '.crt'), join(certDir, cfg.cert443 + '.key'), primaryIPv4(), log);
  await bind(cfg.grpcPort, cfg.cert443);
  await bind(cfg.appProtoPort, cfg.cert8084);
  let lastConnCheck = Date.now(); // 从启动时算起：刚起来时不该立刻报警
  await startHttp80(cfg.httpPort, log, () => { lastConnCheck = Date.now(); });
  // config.json 里 "mdns": false 时不做 mDNS 广播（同网段已有别的 pod，或只想在本机调试）
  const mdns = cfg.mdns === false ? { stop: () => {}, announce: () => {} } : startMdns(cfg.appProtoPort, log);

  writeFileSync(join(ROOT, 'pod.pid'), String(process.pid));

  // ---- robot bridge + console API ---------------------------------------
  const robot = new RobotBridge('main', log);
  robotRef = robot;
  const tryConnect = async (): Promise<void> => {
    const bot = store.botInfo.robots[0];
    if (!bot) { setTimeout(tryConnect, 10000); return; }
    const certPath = join(certDir, 'robot.crt');
    try {
      await robot.connect({ esn: bot.esn, ip: bot.ip_address, guid: bot.guid }, protoDir, certPath);
      log.info(`robot connected: ${bot.esn} @ ${bot.ip_address}`);
    } catch (e) {
      const msg = (e as Error).message || '';
      // 令牌不对（401）：机器人可能刚换过 GUID，读一次新记录再来
      if (/UNAUTHENTICATED|401|invalid.*token/i.test(msg) && bot.guid) {
        const fresh = store.botInfo.robots[0];
        if (fresh?.guid) robot.updateAuth(fresh.guid);
      }
      // 证书文件本身不在（用户换了机器、清过 certs）也算证书问题，同样走重新抓取
      if (!/self-signed|CERT|certificate|unable to verify|ENOENT|no such file/i.test(msg)) {
        log.error('robot connect failed: ' + msg);
        setTimeout(tryConnect, 10000);
        return;
      }
      // 证书被机器人换掉了（重新配对的必然结果）：抓一份新的再连一次
      try {
        writeFileSync(certPath, await captureRobotCert(bot.ip_address));
        log.info('robot cert refreshed from ' + bot.ip_address);
        await robot.connect({ esn: bot.esn, ip: bot.ip_address, guid: bot.guid }, protoDir, certPath);
        log.info(`robot connected: ${bot.esn} @ ${bot.ip_address}`);
      } catch (e2) {
        log.error('robot connect failed: ' + (e2 as Error).message);
        setTimeout(tryConnect, 10000);
      }
    }
  };
  void tryConnect();

  // ---- 互动记录（家长端数据来源）--------------------------------------
  activity.append('boot', 'VectorPal 启动了', { ip: primaryIPv4() });
  robot.on('connected', () => { activity.append('boot', '和机器人连上了'); bus.emit('robot', { online: true }); });
  robot.on('disconnected', () => bus.emit('robot', { online: false }));
  robot.on('touch', (t: any) => activity.append('touch', t.touched ? '有人摸了摸它' : '摸完松开了手', { raw: t.raw }));
  robot.on('pickedUp', (v: boolean) => { if (v) activity.append('pickedUp', '它被抱起来了'); });
  robot.on('charger', (v: boolean) => activity.append('charger', v ? '它回到充电台休息' : '它离开充电台去玩了'));
  robot.on('button', (v: boolean) => { if (v) activity.append('button', '有人按了它背上的按钮'); });
  robot.on('cliff', (v: boolean) => { if (v) activity.append('cliff', '它发现前面是桌边，自己停下了'); });

  // ---- 「当……就……」自动反应 -----------------------------------------
  const rules = new RulesEngine({
    robot, rootDir: ROOT, log,
    onRun: (rule, res) => {
      const label = RULE_EVENT_LABELS[rule.event] ?? rule.event;
      activity.append('program', '「' + label + '」时它自己动了 ' + rule.steps.length + ' 步' + (res.ok ? '' : '（中途停了）'));
      bus.emit('ruleRun', { event: rule.event, ok: res.ok, steps: rule.steps.length });
    }
  });
  robot.on('touch', (t: any) => { if (t?.touched) void rules.fire('touch'); });
  robot.on('pickedUp', (v: boolean) => { void rules.fire(v ? 'pickedUp' : 'putDown'); });
  robot.on('charger', (v: boolean) => { void rules.fire(v ? 'chargerOn' : 'chargerOff'); });
  robot.on('cliff', (v: boolean) => { if (v) void rules.fire('cliff'); });
  robot.on('button', (v: boolean) => { if (v) void rules.fire('button'); });
  bus.subs.add((t: string, p: any) => {
    if (t === 'voiceMatch') activity.append('voice', '对它说「' + String(p?.phrase ?? '') + '」，它照做了', { text: p?.text, phrase: p?.phrase });
    else if (t === 'voiceUnmatched') activity.append('voice', '对它说了「' + String(p?.text ?? '') + '」，但它没听懂', { text: p?.text });
  });

  const stt = createStt(join(ROOT, cfg.sttModel ?? 'models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'), log);
  voice = new VoiceService({ robot, rootDir: ROOT, log, stt, onEvent: (t, p) => bus.emit(t, p) });

  // 监听地址：默认只给本机；cfg.apiHost 改成 0.0.0.0 才让手机/平板打开
  const apiHost = String(cfg.apiHost ?? '127.0.0.1').trim() || '127.0.0.1';
  const isLocalOnly = apiHost === '127.0.0.1' || apiHost === '::1' || apiHost === 'localhost';
  let apiPin = String(cfg.apiPin ?? '').trim();
  if (!isLocalOnly && !apiPin) {
    const pinFile = join(dataDir, 'api-pin.txt');
    try { apiPin = existsSync(pinFile) ? readFileSync(pinFile, 'utf8').trim() : ''; } catch { apiPin = ''; }
    if (!/^\d{4,8}$/.test(apiPin)) {
      apiPin = String(Math.floor(100000 + Math.random() * 900000));
      writeFileSync(pinFile, apiPin + '\n', 'utf8');
    }
    log.info(`lan access: http://${primaryIPv4()}:${cfg.apiPort ?? 8090}  pin=${apiPin}`);
  }

  const pair = new PairEngine({
    rootDir: ROOT, store, log,
    hostIp: primaryIPv4(), port: Number(cfg.grpcPort ?? 443),
    certPath: join(certDir, cfg.cert443 + '.crt'),
    onStep: (s) => {
      bus.emit('pair', { running: s.running, step: s.step, done: s.done, error: s.error });
      // 配对完机器人换了证书，旧通道已经没用了，重新连一次
      if (s.done && !s.error) setTimeout(() => { robot.reset(); void tryConnect(); }, 3000);
    }
  });

  await startApi(cfg.apiPort ?? 8090, {
    log, store, robot, rootDir: ROOT, protoDir,
    robotCert: join(certDir, 'robot.crt'), bus, voice, activity, photos, rules, pair,
    host: apiHost, pin: isLocalOnly ? '' : apiPin, lanIp: primaryIPv4(),
    cloudSeen: () => lastConnCheck
  });

  const shutdown = () => {
    log.info('shutting down');
    activity.append('shutdown', 'VectorPal 停止了');
    mdns.stop();
    try { server.forceShutdown(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('pod ready');
}

process.on('uncaughtException', (e: Error) => {
  log.error('uncaught: ' + (e?.message ?? String(e)));
});
process.on('unhandledRejection', (e: unknown) => {
  log.error('unhandled rejection: ' + ((e as Error)?.message ?? String(e)));
});

main().catch(e => {
  log.error('fatal: ' + (e as Error).message);
  process.exit(1);
});