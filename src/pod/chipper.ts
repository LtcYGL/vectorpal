import type { Logger } from './logger.ts';

export type UtteranceHandler = (audio: Buffer, device: string, encoding: string) => void;

function peerOf(call: any): string {
  try {
    const p = call?.getPeer?.();
    return p ? String(p) : '?';
  } catch {
    return '?';
  }
}

type Reply = (device: string, chunks: Buffer[]) => Record<string, unknown>;

/**
 * Shared bidirectional audio stream handler.
 * Firmware sends 16k mono LINEAR_PCM in 100ms chunks and expects one final
 * response; which response message it must be differs per rpc.
 */
function audioStream(label: string, log: Logger, onUtterance: UtteranceHandler | undefined, reply: Reply) {
  return function handle(stream: any): void {
    const chunks: Buffer[] = [];
    let device = '';
    let session = '';
    let encoding = '';
    let opened = Date.now();
    let firstChunk = 0;
    const peer = peerOf(stream);
    log.grpc(`Chipper: ${label} open from ${peer}`);
    stream.on('data', (req: any) => {
      if (!firstChunk) {
        firstChunk = Date.now();
        device = String(req?.device_id ?? '');
        session = String(req?.session ?? '');
        encoding = String(req?.audio_encoding ?? 'LINEAR_PCM');
        log.grpc(
          `Chipper: ${label} start device=${device} session=${session} encoding=${encoding} ` +
          `lang=${req?.language_code ?? ''} fw=${req?.firmware_version ?? ''}`
        );
      }
      const audio = req?.input_audio;
      if (audio && audio.length) chunks.push(Buffer.from(audio));
    });
    stream.on('end', () => {
      const pcm = Buffer.concat(chunks);
      const ms = firstChunk ? Date.now() - firstChunk : 0;
      log.grpc(`Chipper: ${label} end device=${device} bytes=${pcm.length} (1s=32000) dur=${ms}ms total=${Date.now() - opened}ms`);
      try {
        stream.write(reply(device, chunks));
      } catch (e) {
        log.error(`${label} reply failed: ` + (e as Error).message);
      }
      try { stream.end(); } catch { /* ignore */ }
      if (onUtterance && pcm.length > 3200) {
        try {
          onUtterance(pcm, device || 'robot', encoding || 'LINEAR_PCM');
        } catch (e) {
          log.error('utterance handler failed: ' + (e as Error).message);
        }
      }
    });
    stream.on('error', (e: Error) => log.error(`${label} stream error: ` + e.message));
  };
}

export function buildChipperService(log: Logger, onUtterance?: UtteranceHandler) {
  const intentReply: Reply = (device) => ({
    session: '',
    device_id: device,
    is_final: true,
    intent_result: { query_text: '', action: 'intent_system_noaudio' }
  });

  return {
    TextIntent(call: any, cb: any) {
      const text = String(call.request?.text_input ?? '');
      log.grpc(`Chipper: TextIntent from ${peerOf(call)} device=${call.request?.device_id ?? '?'} text="${text}"`);
      cb(null, {
        session: String(call.request?.session ?? ''),
        device_id: String(call.request?.device_id ?? ''),
        is_final: true,
        intent_result: { query_text: text, action: 'intent_system_noaudio' }
      });
    },

    StreamingConnectionCheck(stream: any) {
      let frames = 1;
      let deviceId = '';
      log.grpc(`Chipper: connection check open from ${peerOf(stream)}`);
      stream.on('data', (req: any) => {
        if (!deviceId) {
          deviceId = String(req?.device_id ?? '');
          log.grpc(`Chipper: connection check from ${deviceId} (${req?.total_audio_ms ?? 0}ms/${req?.audio_per_request ?? 0}ms frames)`);
        }
        frames++;
        const needed = Math.max(1, Math.floor(Number(req?.total_audio_ms ?? 0) / Math.max(1, Number(req?.audio_per_request ?? 1))));
        if (frames >= needed) {
          stream.write({ status: 'Success', frames_received: frames });
        }
      });
      stream.on('end', () => { try { stream.end(); } catch { /* ignore */ } });
      stream.on('error', (e: Error) => log.error('connection check stream error: ' + e.message));
    },

    StreamingIntent: audioStream('StreamingIntent', log, onUtterance, intentReply),

    StreamingKnowledgeGraph: audioStream('StreamingKnowledgeGraph', log, onUtterance, (device) => ({
      session: '',
      device_id: device,
      query_text: '',
      spoken_text: '',
      command_type: '',
      domains_used: [],
      audio_id: ''
    })),

    StreamingIntentGraph: audioStream('StreamingIntentGraph', log, onUtterance, (device) => ({
      session: '',
      device_id: device,
      response_type: 'INTENT',
      is_final: true,
      intent_result: { query_text: '', action: 'intent_system_noaudio' }
    }))
  };
}
