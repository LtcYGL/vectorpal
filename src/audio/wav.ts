export interface WavData { sampleRate: number; channels: number; bitsPerSample: number; samples: Int16Array; }

export function parseWav(buf: Buffer): WavData {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let off = 12;
  let fmt: any = null;
  let dataStart = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error('WAV missing fmt/data chunk');
  if (fmt.bitsPerSample !== 16) throw new Error('only 16-bit PCM supported, got ' + fmt.bitsPerSample);

  const total = Math.floor(dataLen / 2);
  const interleaved = new Int16Array(total);
  for (let i = 0; i < total; i++) interleaved[i] = buf.readInt16LE(dataStart + i * 2);

  // mono mixdown (overlapping copies, same length)
  let samples: Int16Array;
  const ch = fmt.channels;
  if (ch === 1) {
    samples = interleaved;
  } else {
    const frames = Math.floor(total / ch);
    samples = new Int16Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += interleaved[f * ch + c];
      samples[f] = Math.max(-32768, Math.min(32767, Math.round(sum / ch)));
    }
  }
  return { sampleRate: fmt.sampleRate, channels: 1, bitsPerSample: 16, samples };
}

export function resampleLinear(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

export function toPcm16(samples: Int16Array): Buffer {
  const b = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return b;
}
