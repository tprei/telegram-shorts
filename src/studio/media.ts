import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { StudioError } from '../application/errors.js';

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

export interface ByteRange {
  start: number;
  end: number;
}

export type ParsedByteRange = ByteRange | 'unsatisfiable' | null;

export function parseByteRange(header: string, fileSize: number): ParsedByteRange {
  const match = SINGLE_BYTE_RANGE.exec(header);
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0 || fileSize === 0) return 'unsatisfiable';
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }
  const start = Number(match[1]);
  if (match[2] === '') {
    return start < fileSize ? { start, end: fileSize - 1 } : 'unsatisfiable';
  }
  const end = Number(match[2]);
  if (start > end || start >= fileSize) return 'unsatisfiable';
  return { start, end: Math.min(end, fileSize - 1) };
}

export interface ServeFileInput {
  filePath: string;
  contentType: string;
  rangeHeader?: string | null;
  downloadFileName?: string | null;
}

export async function serveFile(input: ServeFileInput): Promise<Response> {
  let fileSize: number;
  try {
    fileSize = (await stat(input.filePath)).size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new StudioError('not_found', `File not found: ${input.filePath}`);
    }
    throw error;
  }
  const headers = new Headers({
    'Content-Type': input.contentType,
    'Accept-Ranges': 'bytes',
  });
  if (input.downloadFileName !== undefined && input.downloadFileName !== null) {
    headers.set('Content-Disposition', `attachment; filename="${input.downloadFileName}"`);
  }
  const rangeHeader = input.rangeHeader ?? null;
  const range = rangeHeader === null ? null : parseByteRange(rangeHeader, fileSize);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${fileSize}`);
    return new Response(null, { status: 416, headers });
  }
  if (fileSize === 0) {
    headers.set('Content-Length', '0');
    return new Response(null, { status: 200, headers });
  }
  const start = range === null ? 0 : range.start;
  const end = range === null ? fileSize - 1 : range.end;
  if (range !== null) {
    headers.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  const body = Readable.toWeb(createReadStream(input.filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
