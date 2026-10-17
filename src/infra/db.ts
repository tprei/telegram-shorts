import { DatabaseSync } from 'node:sqlite';
import type { ExportRecord, JobRecord, JobSummaryRecord, PublicationRecord, QueueTask, QueueTaskKind, QueueTaskPayloads, ShortRecord, ShortVideoPlatform } from '../domain/model.js';
import { createId, ensureParent, nowIso, parseJson } from './util.js';

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);

CREATE TABLE IF NOT EXISTS shorts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  rank INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shorts_job ON shorts(job_id, rank);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  short_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_short ON exports(short_id, created_at);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL,
  short_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_short ON publications(short_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publications_export ON publications(export_id, created_at);

CREATE TABLE IF NOT EXISTS queue_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  available_at TEXT,
  started_at TEXT,
  error TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_tasks_status_available_created ON queue_tasks(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_job ON actions(job_id, created_at);
`;

const ACTIVE_PUBLICATION_STATUSES = ['queued', 'publishing', 'published', 'deferred'] as const;

function payloadJsonColumn(row: unknown): string | null {
  if (row === null || typeof row !== 'object' || !('payload_json' in row)) {
    return null;
  }
  const value = row.payload_json;
  return typeof value === 'string' ? value : null;
}

export class ShortsStore {
  constructor(private readonly db: DatabaseSync) {}

  static async open(path: string): Promise<ShortsStore> {
    await ensureParent(path);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    const versionRow = db.prepare('PRAGMA user_version').get();
    let userVersion = 0;
    if (versionRow !== null && typeof versionRow === 'object' && 'user_version' in versionRow && typeof versionRow.user_version === 'number') {
      userVersion = versionRow.user_version;
    }
    if (userVersion !== 0 && userVersion !== 2 && userVersion !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`Incompatible database at ${path}; delete it to start fresh`);
    }
    if (userVersion === 2) {
      db.exec(`UPDATE jobs SET payload_json = json_set(payload_json, '$.transcriptRevision', 0)`);
      db.exec(`UPDATE exports SET payload_json = json_set(payload_json, '$.transcriptRevision', 0)`);
    }
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return new ShortsStore(db);
  }

  close(): void {
    this.db.close();
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row === null || typeof row !== 'object' || !('value' in row)) {
      return null;
    }
    const value = row.value;
    return typeof value === 'string' ? value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  createJob(job: JobRecord): void {
    this.db.prepare('INSERT INTO jobs(id, status, updated_at, payload_json) VALUES(?, ?, ?, ?)').run(job.id, job.status, job.updatedAt, JSON.stringify(job));
  }

  updateJob(job: JobRecord): void {
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ?, payload_json = ? WHERE id = ?').run(job.status, job.updatedAt, JSON.stringify(job), job.id);
  }

  getJob(id: string): JobRecord | null {
    const payload = payloadJsonColumn(this.db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(id));
    return payload ? parseJson<JobRecord>(payload) : null;
  }

  listJobSummaries(): JobSummaryRecord[] {
    const rows = this.db.prepare("SELECT json_remove(payload_json, '$.transcriptWords', '$.transcriptSentences', '$.semanticBlocks') AS payload_json FROM jobs ORDER BY updated_at DESC").all();
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map((payload) => parseJson<JobSummaryRecord>(payload));
  }

  createShort(short: ShortRecord): void {
    this.db.prepare('INSERT INTO shorts(id, job_id, status, rank, updated_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)').run(short.id, short.jobId, short.status, short.rank, short.updatedAt, JSON.stringify(short));
  }

  updateShort(short: ShortRecord): void {
    this.db.prepare('UPDATE shorts SET status = ?, rank = ?, updated_at = ?, payload_json = ? WHERE id = ?').run(short.status, short.rank, short.updatedAt, JSON.stringify(short), short.id);
  }

  updateShortIfRevision(short: ShortRecord, expectedRevision: number): boolean {
    const result = this.db.prepare("UPDATE shorts SET status = ?, rank = ?, updated_at = ?, payload_json = ? WHERE id = ? AND json_extract(payload_json, '$.editRevision') = ?").run(short.status, short.rank, short.updatedAt, JSON.stringify(short), short.id, expectedRevision);
    return result.changes > 0;
  }

  getShort(id: string): ShortRecord | null {
    const payload = payloadJsonColumn(this.db.prepare('SELECT payload_json FROM shorts WHERE id = ?').get(id));
    return payload ? parseJson<ShortRecord>(payload) : null;
  }

  listShortsForJob(jobId: string): ShortRecord[] {
    const rows = this.db.prepare('SELECT payload_json FROM shorts WHERE job_id = ? ORDER BY rank ASC').all(jobId);
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map((payload) => parseJson<ShortRecord>(payload));
  }

  createExport(record: ExportRecord): void {
    this.db.prepare('INSERT INTO exports(id, job_id, short_id, status, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)').run(record.id, record.jobId, record.shortId, record.status, record.createdAt, JSON.stringify(record));
  }

  updateExport(record: ExportRecord): void {
    this.db.prepare('UPDATE exports SET status = ?, payload_json = ? WHERE id = ?').run(record.status, JSON.stringify(record), record.id);
  }

  getExport(id: string): ExportRecord | null {
    const payload = payloadJsonColumn(this.db.prepare('SELECT payload_json FROM exports WHERE id = ?').get(id));
    return payload ? parseJson<ExportRecord>(payload) : null;
  }

  listExportsForShort(shortId: string): ExportRecord[] {
    const rows = this.db.prepare('SELECT payload_json FROM exports WHERE short_id = ? ORDER BY created_at DESC').all(shortId);
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map((payload) => parseJson<ExportRecord>(payload));
  }

  createPublication(record: PublicationRecord): void {
    this.db.prepare('INSERT INTO publications(id, export_id, short_id, platform, status, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?)').run(record.id, record.exportId, record.shortId, record.platform, record.status, record.createdAt, JSON.stringify(record));
  }

  updatePublication(record: PublicationRecord): void {
    this.db.prepare('UPDATE publications SET status = ?, payload_json = ? WHERE id = ?').run(record.status, JSON.stringify(record), record.id);
  }

  getPublication(id: string): PublicationRecord | null {
    const payload = payloadJsonColumn(this.db.prepare('SELECT payload_json FROM publications WHERE id = ?').get(id));
    return payload ? parseJson<PublicationRecord>(payload) : null;
  }

  listPublicationsForShort(shortId: string): PublicationRecord[] {
    const rows = this.db.prepare('SELECT payload_json FROM publications WHERE short_id = ? ORDER BY created_at DESC').all(shortId);
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map((payload) => parseJson<PublicationRecord>(payload));
  }

  findActivePublication(exportId: string, platform: ShortVideoPlatform): PublicationRecord | null {
    const payload = payloadJsonColumn(this.db.prepare(`SELECT payload_json FROM publications WHERE export_id = ? AND platform = ? AND status IN (${ACTIVE_PUBLICATION_STATUSES.map(() => '?').join(', ')}) ORDER BY created_at DESC LIMIT 1`).get(exportId, platform, ...ACTIVE_PUBLICATION_STATUSES));
    return payload ? parseJson<PublicationRecord>(payload) : null;
  }

  enqueueTask<K extends QueueTaskKind>(jobId: string, kind: K, payload: QueueTaskPayloads[K], options: { availableAt?: string | null } = {}): QueueTask {
    const task: QueueTask = {
      id: createId('task'),
      jobId,
      kind,
      status: 'queued',
      payload,
      createdAt: nowIso(),
      availableAt: options.availableAt ?? null,
      startedAt: null,
      error: null,
    };
    this.db.prepare('INSERT INTO queue_tasks(id, job_id, kind, status, created_at, available_at, started_at, error, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(task.id, task.jobId, task.kind, task.status, task.createdAt, task.availableAt, task.startedAt, task.error, JSON.stringify(task));
    return task;
  }

  claimNextTask(kinds: readonly QueueTaskKind[]): QueueTask | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = nowIso();
      const row = this.db.prepare(`SELECT payload_json FROM queue_tasks WHERE status = 'queued' AND kind IN (${kinds.map(() => '?').join(', ')}) AND (available_at IS NULL OR available_at <= ?) ORDER BY COALESCE(available_at, created_at) ASC, created_at ASC LIMIT 1`).get(...kinds, now);
      const payload = payloadJsonColumn(row);
      if (!payload) {
        this.db.exec('COMMIT');
        return null;
      }
      const task = parseJson<QueueTask>(payload);
      task.status = 'running';
      task.startedAt = nowIso();
      task.availableAt = null;
      this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, started_at = ?, payload_json = ? WHERE id = ?').run(task.status, task.startedAt, JSON.stringify(task), task.id);
      this.db.exec('COMMIT');
      return task;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeTask(task: QueueTask): void {
    task.status = 'done';
    task.availableAt = null;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, payload_json = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
  }

  failTask(task: QueueTask, error: string): void {
    task.status = 'failed';
    task.availableAt = null;
    task.error = error;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, error = ?, payload_json = ? WHERE id = ?').run(task.status, task.error, JSON.stringify(task), task.id);
  }

  rescheduleTask(task: QueueTask, availableAt: string, error: string | null): void {
    task.status = 'queued';
    task.availableAt = availableAt;
    task.startedAt = null;
    task.error = error;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = ?, started_at = NULL, error = ?, payload_json = ? WHERE id = ?').run(task.status, task.availableAt, task.error, JSON.stringify(task), task.id);
  }

  requeueRunningTasks(): void {
    const rows = this.db.prepare("SELECT payload_json FROM queue_tasks WHERE status = 'running'").all();
    for (const payload of rows.map((row) => payloadJsonColumn(row)).filter((value): value is string => value !== null)) {
      const task = parseJson<QueueTask>(payload);
      if (task.kind === 'publish_short_video') {
        this.failInterruptedPublishTask(task);
        continue;
      }
      task.status = 'queued';
      task.startedAt = null;
      task.availableAt = null;
      task.error = null;
      this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, started_at = NULL, error = NULL, payload_json = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
    }
  }

  private failInterruptedPublishTask(task: QueueTask): void {
    const message = 'Interrupted while publishing; check the platform before reposting.';
    this.failTask(task, message);
    const payload = task.payload;
    if (typeof payload !== 'object' || payload === null || !('publicationId' in payload) || typeof payload.publicationId !== 'string') {
      return;
    }
    const publication = this.getPublication(payload.publicationId);
    if (!publication || publication.status === 'published' || publication.status === 'failed') {
      return;
    }
    publication.status = 'failed';
    publication.error = message;
    publication.updatedAt = nowIso();
    this.updatePublication(publication);
  }

  appendAction(jobId: string, kind: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO actions(id, job_id, kind, created_at, payload_json) VALUES(?, ?, ?, ?, ?)').run(createId('act'), jobId, kind, nowIso(), JSON.stringify(payload));
  }
}
