import MDNS from 'multicast-dns';
import { networkInterfaces } from 'node:os';
import type { Logger } from './logger.ts';

const HOST = 'escapepod.local';
const SERVICE = 'escapepod._app-proto._tcp.local';
const PTR = '_app-proto._tcp.local';
const SERVICES = '_services._dns-sd._udp.local';
const TXT = ['txtv=0', 'lo=1', 'la=2'];

export function primaryIPv4(): string {
  const nets = networkInterfaces();
  const bad = /tap|vpn|virtual|bluetooth|loopback|vethernet|wsl|hyper-v|vmware|virtualbox|qmtap/i;
  const all: { name: string; addr: string }[] = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      all.push({ name, addr: ni.address });
    }
  }
  const lan192 = all.filter(c => c.addr.startsWith('192.168.') && !bad.test(c.name));
  if (lan192.length) return lan192[0].addr;
  const clean = all.filter(c => !bad.test(c.name));
  return (clean[0] ?? all[0])?.addr ?? '127.0.0.1';
}

export function startMdns(appProtoPort: number, log: Logger): { stop: () => void; announce: () => void } {
  const ip = primaryIPv4();
  let mdns: any;
  try {
    mdns = MDNS({ loopback: false });
  } catch (e) {
    log.error('mDNS init failed: ' + (e as Error).message);
    return { stop: () => {}, announce: () => {} };
  }

  const ptrRec = { name: PTR, type: 'PTR', ttl: 4500, data: SERVICE };
  const servicesRec = { name: SERVICES, type: 'PTR', ttl: 4500, data: PTR };
  const srvRec = { name: SERVICE, type: 'SRV', ttl: 120, data: { port: appProtoPort, target: HOST, priority: 0, weight: 0 } };
  const txtRec = { name: SERVICE, type: 'TXT', ttl: 4500, data: TXT };
  const aRec = { name: HOST, type: 'A', ttl: 120, data: ip };

  const full = () => [ptrRec, srvRec, txtRec, aRec];

  function answerFor(name: string, qtype: string) {
    if (name === PTR) return { answers: [ptrRec], additionals: [srvRec, txtRec, aRec] };
    if (name === SERVICES) return { answers: [servicesRec], additionals: [] };
    if (name === SERVICE) {
      if (qtype === 'TXT') return { answers: [txtRec], additionals: [] };
      if (qtype === 'SRV') return { answers: [srvRec], additionals: [aRec] };
      return { answers: [srvRec, txtRec], additionals: [aRec] };
    }
    return { answers: [aRec], additionals: [] };
  }

  const mine = (name: string) => name === HOST || name === SERVICE || name === PTR || name === SERVICES;

  mdns.on('query', (packet: any, rinfo: any) => {
    const qs = (packet.questions ?? []).filter((q: any) => mine(String(q.name ?? '').toLowerCase().replace(/\.$/, '')));
    if (!qs.length) return;
    const uni = Boolean(rinfo?.address && rinfo?.port);
    const qu = (Number(packet.flags ?? 0) & 0x8000) !== 0 || Number(rinfo?.port ?? 5353) !== 5353;
    const q = qs[0];
    const name = String(q.name ?? '').toLowerCase().replace(/\.$/, '');
    const qtype = String(q.type ?? 'A');
    log.mdns('answer ' + qtype + ' ' + name + ' from ' + rinfo?.address + ':' + rinfo?.port + (qu ? ' qu' : ''));
    const res = answerFor(name, qtype);
    try { mdns.respond(res); } catch { /* ignore */ }
    if (uni) {
      try { mdns.respond(res, { address: rinfo.address, port: rinfo.port }); } catch { /* ignore */ }
    }
    for (const extra of qs.slice(1)) {
      const n2 = String(extra.name ?? '').toLowerCase().replace(/\.$/, '');
      const r2 = answerFor(n2, String(extra.type ?? 'A'));
      try { mdns.respond(r2); } catch { /* ignore */ }
      if (uni) {
        try { mdns.respond(r2, { address: rinfo.address, port: rinfo.port }); } catch { /* ignore */ }
      }
    }
  });

  mdns.on('error', (e: Error) => log.error('mDNS error: ' + e.message));

  mdns.on('response', (packet: any) => {
    for (const a of packet.answers ?? []) {
      if (a.type === 'PTR' && String(a.name).toLowerCase() === '_ankivector._tcp.local') {
        log.mdns('saw vector service: ' + a.data);
      }
    }
  });
  try { mdns.query({ questions: [{ name: '_ankivector._tcp.local', type: 'PTR' }] }); } catch { /* ignore */ }

  const announce = () => { try { mdns.respond({ answers: full() }); } catch { /* ignore */ } };
  announce();
  setTimeout(announce, 1200);
  const timer = setInterval(announce, 30000);
  if (timer.unref) timer.unref();

  log.mdns('advertising ' + HOST + ' -> ' + ip + ' (_app-proto._tcp:' + appProtoPort + ')');

  return {
    stop: () => { try { clearInterval(timer); mdns.destroy(); } catch { /* ignore */ } },
    announce
  };
}