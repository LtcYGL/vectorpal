// 下载中文语音识别模型（sherpa-onnx 流式 zipformer zh-14M，int8 版约 25MB）
// 用法：npm run model
//
// 先走国内镜像 hf-mirror.com，失败再退回 huggingface.co。
// 下载到 models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/，
// 目录名与 config.json 里的 sttModel 默认值一致；缺这个目录时语音识别会自动关闭，
// 其它功能（动作、编程、说话）不受影响。
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const DIR_NAME = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];
const FILES = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt'
];

const dir = join(ROOT, 'models', DIR_NAME);
mkdirSync(dir, { recursive: true });

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

async function download(name) {
  const dest = join(dir, name);
  if (existsSync(dest) && statSync(dest).size > 1024) {
    console.log('已有，跳过：' + name);
    return;
  }
  let lastErr = null;
  for (const base of MIRRORS) {
    const url = base + '/' + REPO + '/resolve/main/' + name;
    try {
      console.log('下载 ' + name + '  ← ' + base);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      let got = 0, lastPrint = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        const now = Date.now();
        if (now - lastPrint > 400) {
          lastPrint = now;
          const pct = total ? Math.round((got / total) * 100) : 0;
          process.stdout.write('\r  ' + mb(got) + (total ? ' / ' + mb(total) + '  ' + pct + '%' : '') + '   ');
        }
      });
      await pipeline(body, createWriteStream(dest));
      process.stdout.write('\n');
      if (statSync(dest).size < 1024) throw new Error('文件太小，可能下回来的是错误页');
      return;
    } catch (e) {
      lastErr = e;
      try { if (existsSync(dest)) unlinkSync(dest); } catch { /* ignore */ }
      console.log('  失败：' + e.message);
    }
  }
  throw new Error('下载 ' + name + ' 失败：' + (lastErr && lastErr.message));
}

console.log('模型目录：' + dir);
for (const f of FILES) await download(f);
console.log('完成。重启 pod 后语音识别就会启用。');
