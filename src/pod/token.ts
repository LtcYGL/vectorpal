import { generateKeyPairSync, createSign, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Logger } from './logger.ts';
import type { JdocsStore } from './store.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

function isoOffset(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

/** 给机器人现签一张 token.jwt —— vector-cloud 用 ParseUnverified 读它，不验签 */
export function issueRobotToken(esn = ''): string {
  return signJwt(esn ? 'vic:' + esn : 'vic:00601b50', randomUUID());
}

function signJwt(requestorId: string, tokenId: string): string {
  const now = new Date();
  const month = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const header = { alg: 'RS512', typ: 'JWT' };
  const payload = {
    expires: isoOffset(month),
    iat: isoOffset(now),
    permissions: null,
    requestor_id: requestorId,
    token_id: tokenId,
    token_type: 'user+robot',
    user_id: 'wirepod'
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = createSign('RSA-SHA512').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

/**
 * 生成一把客户端令牌（GUID）和它的哈希 —— 算法照抄 wire-pod 的
 * token/hashing.go:47-71：GUID = base64(16 随机字节)；
 * 哈希 = base64(sha256(令牌字节 || 盐) || 盐)，盐 16 字节，所以一共 48 字节。
 * 机器人只存哈希，我们存 GUID；之后机器人拿 GUID 连 SDK，我们用它当 Bearer。
 */
export function createTokenAndHashedToken(): { guid: string; hash: string } {
  const tokenBytes = randomBytes(16);
  const salt = randomBytes(16);
  const digest = createHash('sha256').update(Buffer.concat([tokenBytes, salt])).digest();
  return { guid: tokenBytes.toString('base64'), hash: Buffer.concat([digest, salt]).toString('base64') };
}

interface TokenCall { request: any; getPeer?: () => string; }

function peerIp(call: any): string {
  try {
    const m = /^(?:ipv4:)?([0-9.]+):\d+$/.exec(String(call.getPeer?.() ?? ''));
    return m ? m[1] : '';
  } catch { return ''; }
}

export function buildTokenService(store: JdocsStore, log: Logger) {
  const bundle = (esn: string, ip: string) => {
    const robot = store.botInfo.robots.find(r => (esn && r.esn === esn) || (ip && r.ip_address === ip));
    const clientToken = robot?.guid || '';
    const token = signJwt(esn ? `vic:${esn}` : 'vic:00601b50', randomUUID());
    return { token, client_token: clientToken };
  };

  const esnForIp = (ip: string): string => store.botInfo.robots.find(r => r.ip_address === ip)?.esn ?? '';

  return {
    AssociatePrimaryUser(call: TokenCall, cb: any) {
      const ip = peerIp(call);
      log.grpc(`Token: AssociatePrimaryUser from=${ip || '?'}`);
      cb(null, { data: bundle(esnForIp(ip), ip) });
    },
    ReassociatePrimaryUser(call: TokenCall, cb: any) {
      const ip = peerIp(call);
      log.grpc(`Token: ReassociatePrimaryUser from=${ip || '?'}`);
      cb(null, { data: bundle(esnForIp(ip), ip) });
    },
    AssociateSecondaryClient(call: TokenCall, cb: any) {
      const ip = peerIp(call);
      log.grpc(`Token: AssociateSecondaryClient from=${ip || '?'} client=${call.request?.client_name ?? ''} app=${call.request?.app_id ?? ''}`);
      cb(null, { data: bundle(esnForIp(ip), ip) });
    },
    RefreshToken(call: TokenCall, cb: any) {
      const ip = peerIp(call);
      log.grpc(`Token: RefreshToken from=${ip || '?'}`);
      cb(null, { data: bundle(esnForIp(ip), ip) });
    },
    DisassociatePrimaryUser(call: TokenCall, cb: any) {
      log.grpc('Token: DisassociatePrimaryUser');
      cb(null, {});
    },
    ListRevokedTokens(_call: TokenCall, cb: any) {
      cb(null, { data: { tokens: [], last_key: '', done: true } });
    },
    RevokeFactoryCertificate(_call: TokenCall, cb: any) { cb(null, {}); },
    RevokeTokens(_call: TokenCall, cb: any) { cb(null, { tokens_revoked: 0 }); }
  };
}
