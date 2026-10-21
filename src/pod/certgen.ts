import { generateKeyPairSync, createSign, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Logger } from './logger.ts';

/**
 * 自己签一张服务端证书 —— 不依赖 openssl、不联网。
 *
 * 为什么必须自己签：机器人接到 server_config.json 里的地址后，是用 **IP** 去连
 * `<ip>:443` 的，gRPC 的 TLS 握手会拿这个 IP 去校验证书的 subjectAltName。
 * 只要证书里没有 `IP:<这个 IP>`，握手就在第一秒失败，现象是「
 * 能解析到服务端、但服务端收不到任何连接」，很容易误判成防火墙或 mDNS 问题。
 *
 * 这里的做法和 wire-pod 的 setup/certs.go 一致：一张自签的 RSA-2048 证书，SAN 里
 * 同时写 DNS 名和当前网卡的 IPv4；机器人那边由配对流程把这张证书塞进
 * /data/data/wirepod-cert.crt 当作信任根。
 */

const TAG = { SEQ: 0x30, SET: 0x31, INT: 0x02, BIT: 0x03, OCT: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c, UTC: 0x17, BOOL: 0x01, CTX0: 0xa0, CTX3: 0xa3 };

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), len(b.length), b]);
}

const seq = (...items: Buffer[]): Buffer => tlv(TAG.SEQ, ...items);

function integer(value: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof value === 'number') {
    const out: number[] = [];
    let n = value;
    do { out.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
    b = Buffer.from(out);
  } else {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i++;
    b = value.subarray(i);
  }
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(TAG.INT, b);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0] + parts[1]];
  for (const arc of parts.slice(2)) {
    const tmp: number[] = [];
    let v = arc;
    do { tmp.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < tmp.length; i++) out.push(i === tmp.length - 1 ? tmp[i] : tmp[i] | 0x80);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

const OID_SHA256_RSA = oid('1.2.840.113549.1.1.11');
const OID_CN = oid('2.5.4.3');
const OID_BASIC = oid('2.5.29.19');
const OID_KEY_USAGE = oid('2.5.29.15');
const OID_SAN = oid('2.5.29.17');
const OID_EKU = oid('2.5.29.37');
const OID_SERVER_AUTH = oid('1.3.6.1.5.5.7.3.1');
const OID_CLIENT_AUTH = oid('1.3.6.1.5.5.7.3.2');

const algId = (): Buffer => seq(OID_SHA256_RSA, tlv(TAG.NULL));
const rdn = (cn: string): Buffer => seq(tlv(TAG.SET, seq(OID_CN, tlv(TAG.UTF8, Buffer.from(cn, 'utf8')))));

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(TAG.UTC, Buffer.from(s, 'ascii'));
}

function extension(id: Buffer, critical: boolean, value: Buffer): Buffer {
  return seq(id, ...(critical ? [tlv(TAG.BOOL, Buffer.from([0xff]))] : []), tlv(TAG.OCT, value));
}

const ipToBytes = (ip: string): Buffer => Buffer.from(ip.split('.').map(Number));

export interface SelfSignedOptions {
  cn?: string;
  dns?: string[];
  ips?: string[];
  days?: number;
}

/** 现签一张自签证书，返回 PEM 格式的证书和私钥（PKCS#1，Node 与机器人两边的 openssl 都认） */
export function makeSelfSigned(opts: SelfSignedOptions = {}): { certPem: string; keyPem: string } {
  const cn = opts.cn ?? 'escapepod.local';
  const dns = opts.dns ?? ['escapepod.local', 'localhost'];
  const ips = (opts.ips ?? []).filter(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  const days = opts.days ?? 3650;

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const san = seq(...dns.map(d => tlv(0x82, Buffer.from(d, 'ascii'))), ...ips.map(ip => tlv(0x87, ipToBytes(ip))));
  const extensions = seq(
    extension(OID_BASIC, true, seq(tlv(TAG.BOOL, Buffer.from([0xff])))),
    // digitalSignature + keyCertSign，末位补 2 个空位
    extension(OID_KEY_USAGE, true, tlv(TAG.BIT, Buffer.from([0x02, 0x84]))),
    extension(OID_SAN, false, san),
    extension(OID_EKU, false, seq(OID_SERVER_AUTH, OID_CLIENT_AUTH))
  );

  const tbs = seq(
    tlv(TAG.CTX0, integer(2)),                        // v3
    integer(serial),
    algId(),
    rdn(cn),
    seq(utcTime(new Date(now - 86400000)), utcTime(new Date(now + days * 86400000))),
    rdn(cn),
    spki,
    tlv(TAG.CTX3, extensions)
  );

  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const der = seq(tbs, algId(), tlv(TAG.BIT, Buffer.from([0]), signature));
  return {
    certPem: toPem('CERTIFICATE', der),
    keyPem: toPem('RSA PRIVATE KEY', privateKey.export({ type: 'pkcs1', format: 'der' }) as Buffer)
  };
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** 证书里有没有包含这个 IP 的 SAN（机器人就是按这个校验的） */
export function certCoversIp(certPem: string, ip: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    const san = String(cert.subjectAltName ?? '');
    // 必须整项相等：'IP Address:192.168.1.21' 里也包含 'IP Address:192.168.1.2'
    return san.split(/,\s*/).some(x => x === 'IP Address:' + ip);
  } catch {
    return false;
  }
}

function daysLeft(certPem: string): number {
  try {
    const cert = new X509Certificate(certPem);
    return (new Date(cert.validTo).getTime() - Date.now()) / 86400000;
  } catch {
    return -1;
  }
}

/**
 * 确保 certs/<name>.crt|.key 存在、没过期、而且 SAN 里有当前网卡 IP。
 * 不满足就重签一张（旧的留 .bak），返回是否重签了。
 */
export function ensureServerCert(certPath: string, keyPath: string, ip: string, log: Logger): boolean {
  const have = existsSync(certPath) && existsSync(keyPath);
  if (have) {
    let pem = '';
    try { pem = readFileSync(certPath, 'utf8'); } catch { pem = ''; }
    if (pem && certCoversIp(pem, ip) && daysLeft(pem) > 30) return false;
    try { writeFileSync(certPath + '.bak', pem); } catch { /* ignore */ }
    log.info('证书里没有 ' + ip + ' 的 SAN，重签一张（机器人按 IP 校验证书，缺了会连不上）');
  }
  const { certPem, keyPem } = makeSelfSigned({ dns: ['escapepod.local', 'localhost'], ips: [ip, '127.0.0.1'] });
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  log.info('已签发新证书 ' + certPath + '（SAN: DNS:escapepod.local, IP:' + ip + '）');
  return true;
}
