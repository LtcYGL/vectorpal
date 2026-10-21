import type { Logger } from './logger.ts';
import type { JdocsStore } from './store.ts';
import { createTokenAndHashedToken } from './token.ts';

interface ReadDocsCall { request: { user_id?: string; thing?: string; items?: { doc_name?: string; my_doc_version?: number }[] }; }
interface ReadDocsCb { (err: unknown, resp?: any): void; }
interface WriteDocCall { request: { user_id?: string; thing?: string; doc_name?: string; doc?: any }; getPeer?: () => any; }
interface CtxCall { request: any; getPeer?: () => any; }

function peerIp(call: any): string {
  try {
    const peer = call.getPeer?.();
    if (!peer) return '';
    const m = /^(?:ipv4:)?([0-9.]+):\d+$/.exec(String(peer));
    return m ? m[1] : '';
  } catch { return ''; }
}

/**
 * 机器人第一次来要 vic.AppTokens 时给它发一把钥匙 —— 这就是 wire-pod 的「配对」。
 * 逻辑照抄 chipper/pkg/servers/jdocs/server.go:76-166：
 *   没登记过的机器人 → 现生成 GUID + 哈希，哈希写进它的 jdoc，GUID 我们自己留着当 Bearer；
 *   登记过的（guid+hash 都在）→ 用原来的哈希重建 doc，机器人不必重新配。
 */
function tokenDoc(hash: string) {
  return {
    client_tokens: [{ hash, client_name: '', app_id: '', issued_at: new Date().toISOString(), is_primary: true }]
  };
}

function ensureAppTokens(store: JdocsStore, log: Logger, thing: string, esn: string, ip: string, names: string[], onNewRobot?: (esn: string, ip: string, guid: string) => void): void {
  const name = names.find(n => n.includes('vic.AppTokens'));
  if (!name || !esn || store.get(thing, name)) return;
  const bot = store.robotByEsn(esn);
  if (bot?.guid && bot?.hash) {
    store.set(thing, name, { doc_version: 1, fmt_version: 1, client_metadata: '', json_doc: JSON.stringify(tokenDoc(bot.hash)) });
    log.info(`pair: 重新下发 ${esn} 的令牌（这台以前接入过）`);
    return;
  }
  const { guid, hash } = createTokenAndHashedToken();
  store.set(thing, name, { doc_version: 1, fmt_version: 1, client_metadata: '', json_doc: JSON.stringify(tokenDoc(hash)) });
  store.setRobotToken(esn, ip, guid, hash);
  log.info(`pair: 新机器人接入 ${esn} @ ${ip || '?'}（GUID ${guid}）`);
  try { onNewRobot?.(esn, ip, guid); } catch { /* ignore */ }
}

export function buildJdocsService(store: JdocsStore, log: Logger, onNewRobot?: (esn: string, ip: string, guid: string) => void) {
  return {
    ReadDocs(call: ReadDocsCall, cb: ReadDocsCb) {
      const thing = String(call.request.thing ?? '');
      const ip = peerIp(call);
      const esn = thing.includes(':') ? thing.split(':')[1] : '';
      const names = (call.request.items ?? []).map(i => String(i.doc_name ?? ''));
      log.grpc(`ReadDocs thing=${thing} from=${ip || '?'} items=[${names.join(', ')}]`);
      if (thing) store.noteRobot(esn, ip);
      ensureAppTokens(store, log, thing, esn, ip, names, onNewRobot);

      const items = (call.request.items ?? []).map(it => {
        const doc = store.get(thing, String(it.doc_name ?? ''));
        // 没有的 doc 不是「NOT_FOUND」，而是给一个空壳 —— wire-pod 也是这么回的
        // （server.go:177-184，client_metadata 标记 wirepod-noexist），机器人收到空壳
        // 会自己建默认值；回 NOT_FOUND 会让它在 onboarding 里卡住。
        if (!doc) return { status: 'CHANGED', doc: { doc_version: 0, fmt_version: 0, client_metadata: 'wirepod-noexist', json_doc: '' } };
        return { status: 'CHANGED', doc };
      });
      cb(null, { items });
    },

    WriteDoc(call: WriteDocCall, cb: ReadDocsCb) {
      const thing = String(call.request.thing ?? '');
      const name = String(call.request.doc_name ?? '');
      const ip = peerIp(call);
      const esn = thing.includes(':') ? thing.split(':')[1] : '';
      log.grpc(`WriteDoc thing=${thing} name=${name} from=${ip || '?'}`);
      if (thing) store.noteRobot(esn, ip);
      const incoming = call.request.doc ?? {};
      const latest = store.set(thing, name, {
        doc_version: Number(incoming.doc_version ?? 0),
        fmt_version: Number(incoming.fmt_version ?? 1),
        client_metadata: String(incoming.client_metadata ?? ''),
        json_doc: String(incoming.json_doc ?? '{}')
      });
      cb(null, { status: 'ACCEPTED', latest_doc_version: latest });
    },

    DeleteDoc(call: CtxCall, cb: ReadDocsCb) {
      const thing = String(call.request.thing ?? '');
      const name = String(call.request.doc_name ?? '');
      const before = store.entries.length;
      store.entries = store.entries.filter(e => !(e.thing === thing && e.name === name));
      if (store.entries.length !== before) store.save();
      log.grpc(`DeleteDoc thing=${thing} name=${name}`);
      cb(null, {});
    },

    PurgeAccountDocs(_call: CtxCall, cb: ReadDocsCb) {
      cb(null, {});
    },

    ViewAccountDocs(call: CtxCall, cb: ReadDocsCb) {
      const thing = String(call.request.thing ?? '');
      cb(null, { items: store.entries.filter(e => e.thing === thing).map(e => ({ user_id: '', thing: e.thing, doc_name: e.name, json_doc: e.jdoc.json_doc })) });
    }
  };
}
