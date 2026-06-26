import { writeFile } from 'node:fs/promises';
import { Candidate } from '../domain/model.js';
import { buildArcPreviewSvg } from '../domain/semantic.js';
import { ensureParent } from './util.js';

export async function writeArcPreview(path: string, candidate: Candidate): Promise<void> {
  await ensureParent(path);
  await writeFile(path, buildArcPreviewSvg(candidate), 'utf-8');
}
