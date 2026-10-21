// 打包 Windows 便携包：dist/vectorpal-<版本>-win-x64/ 和同名 .zip
// 里面自带 node.exe、运行时依赖、中文语音模型，解压即用；
// 也用于 GitHub Actions 在打 tag 时生成 Release 资产。
//
//   node scripts/build-portable.mjs
//
// 环境变量 NODE_EXE 可以指定要打包的 node.exe（默认用当前运行的这一个）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = 'vectorpal-' + pkg.version + '-win-x64';
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, NAME);
const ZIP = join(DIST, NAME + '.zip');

const MODEL_DIR = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const MODEL_FILES = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt'
];
const FALLBACK = ['src', 'public', 'proto', 'certs', 'assets', 'scripts',
  'config.json', 'package.json', 'package-lock.json', 'keepalive.mjs',
  'start.bat', 'start-hidden.vbs', 'README.md', 'LICENSE', 'NOTICE.md'];

function tracked() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
    const list = out.toString('utf8').split('\u0000').filter(Boolean);
    if (list.length) return list;
  } catch { /* 没有 git 就按固定清单拷 */ }
  const list = [];
  for (const p of FALLBACK) {
    if (!existsSync(join(ROOT, p))) continue;
    if (statSync(join(ROOT, p)).isDirectory()) {
      for (const f of readdirSync(join(ROOT, p), { recursive: true })) list.push(p + '/' + String(f).replaceAll('\\', '/'));
    } else list.push(p);
  }
  return list;
}

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

rmSync(DIST, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let files = 0;
for (const rel of tracked()) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) continue;
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  files++;
}

// 运行时依赖（npm ci --omit=dev 装出来的那一份）
if (!existsSync(join(ROOT, 'node_modules'))) throw new Error('先跑 npm ci --omit=dev：node_modules 不存在');
cpSync(join(ROOT, 'node_modules'), join(OUT, 'node_modules'), { recursive: true });

// 中文语音模型（只带 int8 那四个文件，约 25MB）
const md = join(ROOT, 'models', MODEL_DIR);
if (existsSync(md)) {
  mkdirSync(join(OUT, 'models', MODEL_DIR), { recursive: true });
  let got = 0;
  for (const f of MODEL_FILES) {
    if (!existsSync(join(md, f))) { console.warn('缺模型文件，跳过：' + f); continue; }
    cpSync(join(md, f), join(OUT, 'models', MODEL_DIR, f));
    got++;
  }
  console.log('模型文件 ' + got + '/' + MODEL_FILES.length);
} else {
  console.warn('没有 models/' + MODEL_DIR + '：打出来的包语音识别不可用（可用 npm run model 下载）');
}

// node 运行时本身
const nodeExe = process.env.NODE_EXE || process.execPath;
cpSync(nodeExe, join(OUT, 'node.exe'));
console.log('node.exe ← ' + nodeExe);

// 别把开发期的空目录/残留带进包
for (const junk of ['logs', 'data', 'pod.pid', 'keepalive.pid', 'dist', 'tools', 'PROGRESS.md']) {
  rmSync(join(OUT, junk), { recursive: true, force: true });
}

// 压缩：优先用 Windows 10+ 自带的 bsdtar（按扩展名自动出 zip），
// 没有就退回 PowerShell 的 Compress-Archive（Git Bash 里的 GNU tar 不支持 zip）
const sysTar = 'C:\\Windows\\System32\\tar.exe';
let zipped = false;
if (existsSync(sysTar)) {
  zipped = spawnSync(sysTar, ['-a', '-c', '-f', ZIP, '-C', DIST, NAME], { stdio: 'inherit' }).status === 0;
}
if (!zipped) {
  zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path "' + join(DIST, NAME) + '" -DestinationPath "' + ZIP + '" -Force'
  ], { stdio: 'inherit' }).status === 0;
}
if (!zipped) throw new Error('压缩失败：找不到可用的压缩工具（需要 Windows 自带 tar 或 PowerShell）');

console.log('文件 ' + files + ' 个');
console.log('目录 ' + mb(statSync(OUT).isDirectory() ? dirSize(OUT) : 0));
console.log('压缩包 ' + ZIP + '  ' + mb(statSync(ZIP).size));

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}
