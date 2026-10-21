import { OnlineRecognizer } from 'sherpa-onnx-node';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SttResult { text: string; ms: number }

export interface SttEngine {
  ready: boolean;
  model: string;
  transcribe(pcm: Buffer, sampleRate?: number): SttResult;
}

const EMPTY: SttEngine = { ready: false, model: '', transcribe: () => ({ text: '', ms: 0 }) };

export function createStt(modelDir: string, log: { info: (s: string) => void; error: (s: string) => void }): SttEngine {
  if (!existsSync(modelDir)) {
    log.error('stt: model dir not found: ' + modelDir);
    return EMPTY;
  }
  const files = readdirSync(modelDir);
  const pick = (re: RegExp) => files.find(f => re.test(f)) ?? '';
  const encoder = pick(/^encoder.*\.onnx$/i);
  const decoder = pick(/^decoder.*\.onnx$/i);
  const joiner = pick(/^joiner.*\.onnx$/i);
  const tokens = pick(/^tokens\.txt$/i);
  if (!encoder || !decoder || !joiner || !tokens) {
    log.error(`stt: incomplete model files (encoder=${encoder || '-'} decoder=${decoder || '-'} joiner=${joiner || '-'} tokens=${tokens || '-'})`);
    return EMPTY;
  }
  let recognizer: any;
  try {
    recognizer = new OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(modelDir, encoder),
          decoder: join(modelDir, decoder),
          joiner: join(modelDir, joiner)
        },
        tokens: join(modelDir, tokens),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
        modelType: 'zipformer'
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20
    });
  } catch (e) {
    log.error('stt: init failed: ' + (e as Error).message);
    return EMPTY;
  }
  log.info('stt: offline recognizer ready (' + encoder + ')');

  return {
    ready: true,
    model: modelDir,
    transcribe(pcm: Buffer, sampleRate = 16000): SttResult {
      const t0 = Date.now();
      const n = Math.floor(pcm.length / 2);
      if (n < 1600) return { text: '', ms: 0 };
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const r = recognizer.getResult(stream);
      return { text: String(r?.text ?? '').trim(), ms: Date.now() - t0 };
    }
  };
}
