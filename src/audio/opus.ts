import { createRequire } from 'node:module';
import { oggPackets } from './ogg.ts';

const require = createRequire(import.meta.url);

export type OpusDecoder = {
  decodeOgg(buf: Buffer): Buffer;
  decodePacket(packet: Buffer): Buffer;
  close(): void;
};

/**
 * Opus decoder for the robot's intent audio.
 * The firmware streams OGG_OPUS (Opus header + tags + one packet per 20ms frame),
 * so we demux the Ogg pages ourselves and decode each packet to signed 16-bit
 * little-endian PCM at the requested rate.
 */
export function createOpusDecoder(sampleRate = 16000): OpusDecoder {
  const OpusScript = require('opusscript');
  const app = OpusScript.Application?.AUDIO ?? 2049;
  const dec = new OpusScript(sampleRate, 1, app, { wasm: true });
  return {
    decodePacket(packet: Buffer): Buffer {
      return Buffer.from(dec.decode(packet));
    },
    decodeOgg(buf: Buffer): Buffer {
      const parts: Buffer[] = [];
      for (const packet of oggPackets(buf)) {
        if (packet.length < 1) continue;
        if (packet.length >= 8) {
          const magic = packet.toString('latin1', 0, 8);
          if (magic === 'OpusHead' || magic === 'OpusTags') continue;
        }
        try {
          parts.push(Buffer.from(dec.decode(packet)));
        } catch {
          // skip a corrupt frame rather than losing the whole utterance
        }
      }
      return Buffer.concat(parts);
    },
    close(): void {
      try { dec.delete(); } catch { /* ignore */ }
    }
  };
}
