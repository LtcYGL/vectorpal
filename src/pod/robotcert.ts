import tls from 'node:tls';

// 机器人的 :443 用自签证书，重装/重新配对后它会换一把新证书，
// 所以我们必须在连不上时重新把它抓回来，而不是写死一份旧证书。
export function captureRobotCert(ip: string, port = 443, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: ip, port, rejectUnauthorized: false });
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error('读证书超时（' + ip + ':' + port + '）')));
    sock.once('error', fail);
    sock.once('secureConnect', () => {
      if (settled) return;
      const c = sock.getPeerCertificate(true);
      if (!c || !c.raw || !c.raw.length) { fail(new Error('没拿到证书')); return; }
      settled = true;
      const b64 = c.raw.toString('base64').replace(/(.{64})/g, '$1\n').trim();
      try { sock.destroy(); } catch { /* ignore */ }
      resolve('-----BEGIN CERTIFICATE-----\n' + b64 + '\n-----END CERTIFICATE-----\n');
    });
  });
}
