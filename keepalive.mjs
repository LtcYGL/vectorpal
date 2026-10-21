// VectorPal 守护：每隔 10 秒探一次 pod 的 /api/health，
// 连续 2 次没回应就把它拉起来；连着 3 次没回应但进程还活着（卡死）就先杀掉再拉。
// 用 start-hidden.vbs 指向本文件即可，开机自启也走它。
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname);
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const PORT = cfg.apiPort ?? 8090;
const HEALTH = 'http://127.0.0.1:' + PORT + '/api/health';
const LOG_DIR = join(ROOT, cfg.logDir ?? 'logs');
const LOG_FILE = join(LOG_DIR, 'keepalive.log');
mkdirSync(LOG_DIR, { recursive: true });
try { writeFileSync(join(ROOT, 'keepalive.pid'), String(process.pid)); } catch { /* ignore */ }

function note(msg) {
  const line = new Date().toLocaleString('zh-CN') + '  ' + msg;
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch { /* ignore */ }
}

async function alive() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

let child = null;
let lastSpawnAt = 0;
function spawnPod() {
  lastSpawnAt = Date.now();
  try {
    child = spawn(process.execPath, [join(ROOT, 'src', 'pod', 'main.ts')], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true
    });
    child.on('exit', (code) => note('pod exited code=' + code));
    child.unref();
    note('pod started pid=' + child.pid);
  } catch (e) {
    note('pod spawn failed: ' + e.message);
  }
}

let misses = 0;
let fastExits = 0;
const exited = () => !child || child.exitCode !== null || child.signalCode;
note('keepalive watching ' + HEALTH);
for (;;) {
  if (await alive()) {
    if (misses) note('pod healthy again');
    misses = 0;
  } else {
    misses++;
    if (misses === 1) note('health check failed');
    // 进程还在但三次都不应人：判为卡死，杀掉让下一轮重新拉起
    if (misses >= 3 && !exited()) {
      note('pod not responding, killing pid=' + child.pid);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      await sleep(1500);
    }
    if (exited()) {
      // 起来几秒就退（端口被占用、配置写错之类）时别疯狂重启，退避一分钟并留线索
      if (lastSpawnAt && Date.now() - lastSpawnAt < 15000) {
        fastExits++;
      } else {
        fastExits = 0;
      }
      if (fastExits >= 3) {
        note('pod 连续 ' + fastExits + ' 次刚起就退出，等 60 秒再试；原因看 ' + LOG_DIR + '\\pod.log');
        await sleep(60000);
        fastExits = 0;
      }
      spawnPod();
    }
  }
  await sleep(10000);
}
