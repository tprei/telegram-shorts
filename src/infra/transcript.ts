import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { AppConfig } from './env.js';
import { TranscriptProvider, TranscriptWord } from '../domain/model.js';

export async function transcribeSource(config: AppConfig, audioPath: string): Promise<TranscriptWord[]> {
  const provider = config.TELEGRAM_SHORTS_TRANSCRIPT_PROVIDER as TranscriptProvider;
  if (provider === 'scribe') {
    if (!config.ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY is required for scribe transcription.');
    }
    return transcribeWithScribe(config.ELEVENLABS_API_KEY, audioPath);
  }
  if (!config.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is required for Deepgram transcription.');
  }
  return transcribeWithDeepgram(config.DEEPGRAM_API_KEY, audioPath);
}

async function transcribeWithDeepgram(apiKey: string, audioPath: string): Promise<TranscriptWord[]> {
  const buffer = await readFile(audioPath);
  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=pt-BR&punctuate=true&smart_format=true&diarize=true', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': mimeType(audioPath),
    },
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`Deepgram transcription failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          words?: Array<{
            word?: string;
            punctuated_word?: string;
            start?: number;
            end?: number;
            speaker?: number;
            confidence?: number;
          }>;
        }>;
      }>;
    };
  };
  const rawWords = payload.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  const words = rawWords
    .map((word, index) => ({
      id: `w_${String(index + 1).padStart(6, '0')}`,
      text: (word.punctuated_word ?? word.word ?? '').trim(),
      startSeconds: Number(word.start ?? 0),
      endSeconds: Number(word.end ?? 0),
      speakerId: `speaker_${String(word.speaker ?? 0)}`,
      confidence: typeof word.confidence === 'number' ? word.confidence : null,
    }))
    .filter((word) => word.text.length > 0 && word.endSeconds > word.startSeconds);
  if (words.length === 0) {
    throw new Error('Deepgram returned no usable words.');
  }
  return words;
}

async function transcribeWithScribe(apiKey: string, audioPath: string): Promise<TranscriptWord[]> {
  const buffer = await readFile(audioPath);
  const form = new FormData();
  form.set('model_id', 'scribe_v1');
  form.set('language_code', 'pt');
  form.set('diarize', 'true');
  form.set('timestamps_granularity', 'word');
  form.set('file', new Blob([buffer], { type: mimeType(audioPath) }), audioPath.split('/').at(-1) ?? 'audio.m4a');
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs Scribe transcription failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as {
    words?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker_id?: string;
      confidence?: number;
      type?: string;
    }>;
    segments?: Array<{
      words?: Array<{
        text?: string;
        start?: number;
        end?: number;
        speaker_id?: string;
        confidence?: number;
        type?: string;
      }>;
    }>;
  };
  const rawWords = payload.words ?? payload.segments?.flatMap((segment) => segment.words ?? []) ?? [];
  const words = rawWords
    .map((word, index) => ({
      id: `w_${String(index + 1).padStart(6, '0')}`,
      text: (word.text ?? '').trim(),
      startSeconds: Number(word.start ?? 0),
      endSeconds: Number(word.end ?? 0),
      speakerId: String(word.speaker_id ?? 'speaker_0'),
      confidence: typeof word.confidence === 'number' ? word.confidence : null,
      kind: word.type ?? 'word',
    }))
    .filter((word) => word.kind === 'word' && word.text.length > 0 && word.endSeconds > word.startSeconds)
    .map(({ kind: _kind, ...word }) => word);
  if (words.length === 0) {
    throw new Error('ElevenLabs Scribe returned no usable words.');
  }
  return words;
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.mp3') {
    return 'audio/mpeg';
  }
  if (extension === '.wav') {
    return 'audio/wav';
  }
  if (extension === '.m4a') {
    return 'audio/mp4';
  }
  return 'application/octet-stream';
}
