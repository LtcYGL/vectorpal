import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Jdoc { doc_version: number; fmt_version: number; client_metadata: string; json_doc: string; }
export interface JdocEntry { thing: string; name: string; jdoc: Jdoc; }
export interface BotRecord { esn: string; ip_address: string; guid: string; activated: boolean; hash?: string; }
export interface BotInfo { global_guid: string; robots: BotRecord[]; }

const emptyJdoc = (): Jdoc => ({ doc_version: 0, fmt_version: 1, client_metadata: '', json_doc: '{}' });

export class JdocsStore {
  entries: JdocEntry[] = [];
  botInfo: BotInfo = { global_guid: 'tni1TRsTRTaNSapjo0Y+Sw==', robots: [] };
  private jdocsPath: string;
  private botInfoPath: string;
  constructor(jdocsPath: string, botInfoPath: string) {
    this.jdocsPath = jdocsPath;
    this.botInfoPath = botInfoPath;
    this.load();
  }

  load(): void {
    if (existsSync(this.jdocsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.jdocsPath, 'utf8'));
        if (Array.isArray(raw)) {
          this.entries = raw.map((e: any) => ({
            thing: String(e.thing ?? ''),
            name: String(e.name ?? ''),
            jdoc: {
              doc_version: Number(e.jdoc?.doc_version ?? 0),
              fmt_version: Number(e.jdoc?.fmt_version ?? 1),
              client_metadata: String(e.jdoc?.client_metadata ?? ''),
              json_doc: String(e.jdoc?.json_doc ?? '{}')
            }
          }));
        }
      } catch { /* keep empty */ }
    }
    if (existsSync(this.botInfoPath)) {
      try { this.botInfo = JSON.parse(readFileSync(this.botInfoPath, 'utf8')); } catch { /* ignore */ }
    }
  }

  save(): void {
    writeFileSync(this.jdocsPath, JSON.stringify(this.entries), 'utf8');
    writeFileSync(this.botInfoPath, JSON.stringify(this.botInfo), 'utf8');
  }

  get(thing: string, name: string): Jdoc | undefined {
    return this.entries.find(e => e.thing === thing && e.name === name)?.jdoc;
  }

  set(thing: string, name: string, jdoc: Jdoc): number {
    const existing = this.entries.find(e => e.thing === thing && e.name === name);
    const version = Math.max(Number(existing?.jdoc.doc_version ?? 0), Number(jdoc.doc_version)) + 1;
    const entry: JdocEntry = { thing, name, jdoc: { ...jdoc, doc_version: version } };
    if (existing) {
      const i = this.entries.indexOf(existing);
      this.entries[i] = entry;
    } else {
      this.entries.push(entry);
    }
    this.save();
    return version;
  }

  robotByEsn(esn: string): BotRecord | undefined {
    return this.botInfo.robots.find(r => r.esn === esn);
  }

  robotByIp(ip: string): BotRecord | undefined {
    return this.botInfo.robots.find(r => r.ip_address === ip);
  }

  /** 给机器人发钥匙：GUID 我们自己留着当 Bearer，哈希写给机器人。 */
  setRobotToken(esn: string, ip: string, guid: string, hash: string): void {
    if (!esn) return;
    const found = this.botInfo.robots.find(r => r.esn === esn);
    if (found) {
      found.guid = guid;
      found.hash = hash;
      found.activated = true;
      if (ip) found.ip_address = ip;
    } else {
      this.botInfo.robots.push({ esn, ip_address: ip, guid, hash, activated: true });
    }
    this.save();
  }

  noteRobot(esn: string, ip: string): void {
    if (!esn) return;
    if (!ip || /^(127\.|::1$|0\.0\.0\.0$)/.test(ip)) return;
    const found = this.botInfo.robots.find(r => r.esn === esn);
    if (found) {
      if (ip && found.ip_address !== ip) { found.ip_address = ip; this.save(); }
      return;
    }
    this.botInfo.robots.push({ esn, ip_address: ip, guid: '', activated: false });
    this.save();
  }
}