import { createServer } from 'node:http';
import type { Logger } from './logger.ts';

export function startHttp80(port: number, log: Logger, onConnCheck?: () => void): Promise<void> {
  // 机器人每几秒就来做一次连通性检查，逐条写日志一天能写上万行，只留每 60 秒一条
  let lastCheckLog = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.includes('/ok')) {
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const now = Date.now();
      if (now - lastCheckLog > 60000) {
        lastCheckLog = now;
        log.http(`connCheck from ${from}${url.includes('runMDNS=true') ? ' (runMDNS)' : ''}`);
      }
      onConnCheck?.();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    log.http(`${req.method} ${url}`);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        return reject(new Error(`端口 ${port} 已被占用：机器人要靠这个端口做连通性检查，不能换。`
          + `请先关掉占着它的程序（可能是一个没退干净的旧 VectorPal），再重新打开。`));
      }
      return reject(e);
    });
    server.listen(port, '0.0.0.0', () => {
      log.info(`HTTP listening on :${port}`);
      resolve();
    });
  });
}
