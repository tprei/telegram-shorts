import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { publicationStartedAt, type AutopilotVideoRecord, type ExportRecord, type JobRecord, type JobSummaryRecord, type PublicationRecord, type QueueTask, type QueueTaskKind, type QueueTaskPayloads, type ShortRecord } from '../domain/model.js';
import { migrateToV8, readLegacyManifestAccountMap } from './migrate-v8.js';
import { createId, ensureParent, nowIso, parseJson } from './util.js';

const CropBackfillRowSchema = z.strictObject({ job_id: z.string(), short_id: z.string() });

const SCHEMA_VERSION = 8;

export const CHECK_PUBLISH_DELAY_MS = 15_000;

export const CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

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

CREATE TABLE IF NOT EXISTS autopilot_videos (
  creator_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (creator_id, video_id)
);
`;

function payloadJsonColumn(row: unknown): string | null {
  if (row === null || typeof row !== 'object' || !('payload_json' in row)) {
    return null;
  }
  const value = row.payload_json;
  return typeof value === 'string' ? value : null;
}

const AutopilotVideoRecordSchema = z.strictObject({
  creatorId: z.string().min(1),
  videoId: z.string().min(1),
  title: z.string().nullable(),
  status: z.enum(['baseline', 'tracked']),
  jobId: z.string().nullable(),
  detectedAt: z.string().min(1),
  retries: z.number().int().nonnegative(),
  lastRetryAt: z.string().nullable(),
});

function parseAutopilotVideoPayload(payload: string): AutopilotVideoRecord {
  return AutopilotVideoRecordSchema.parse(JSON.parse(payload));
}

export class ShortsStore {
  constructor(private readonly db: DatabaseSync) {}

  static async open(path: string, options: { manifestPath?: string } = {}): Promise<ShortsStore> {
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
    if (userVersion !== 0 && (userVersion < 2 || userVersion > SCHEMA_VERSION)) {
      db.close();
      throw new Error(`Incompatible database at ${path}; delete it to start fresh`);
    }
    let legacyAccountMap: Map<string, string | null> | null = null;
    if (userVersion >= 2 && userVersion <= 7) {
      if (options.manifestPath === undefined) {
        db.close();
        throw new Error(`Database at ${path} is at schema version ${userVersion} and needs a creator manifest to migrate to version ${SCHEMA_VERSION}.`);
      }
      try {
        legacyAccountMap = readLegacyManifestAccountMap(options.manifestPath);
      } catch (error) {
        db.close();
        throw error;
      }
    }
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (userVersion === 2) {
        db.exec(`UPDATE jobs SET payload_json = json_set(payload_json, '$.transcriptRevision', 0)`);
        db.exec(`UPDATE exports SET payload_json = json_set(payload_json, '$.transcriptRevision', 0)`);
      }
      if (userVersion === 2 || userVersion === 3) {
        db.exec(`UPDATE exports SET payload_json = json_set(payload_json, '$.coverPath', json('null'))`);
        migratePublicationsToV4(db);
      }
      if (userVersion >= 2 && userVersion <= 4) {
        db.exec(`UPDATE jobs SET payload_json = json_set(payload_json, '$.hostFraming', json('null'), '$.hostFramingAnalyzedAt', json('null'))`);
        db.exec(`UPDATE exports SET payload_json = json_set(payload_json, '$.hostFraming', json('null'))`);
      }
      if (userVersion >= 2 && userVersion <= 5) {
        db.exec(`UPDATE publications SET payload_json = json_set(payload_json, '$.scheduledFor', json('null'))`);
      }
      if (userVersion >= 2 && userVersion <= 6) {
        db.exec(`UPDATE jobs SET payload_json = json_set(payload_json, '$.creatorProfileSnapshot.schedule', json('{"timeZone":"America/Sao_Paulo","slots":["12:00","19:00","21:00"]}'))`);
      }
      if (legacyAccountMap !== null) {
        migrateToV8(db, legacyAccountMap);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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

  listUpcomingScheduledPublications(): PublicationRecord[] {
    const rows = this.db.prepare("SELECT payload_json FROM publications WHERE status IN ('queued', 'deferred', 'publishing', 'scheduled') AND json_extract(payload_json, '$.scheduledFor') IS NOT NULL ORDER BY json_extract(payload_json, '$.scheduledFor') ASC").all();
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map((payload) => parseJson<PublicationRecord>(payload));
  }

  listAutopilotVideos(creatorId: string): AutopilotVideoRecord[] {
    const rows = this.db.prepare('SELECT payload_json FROM autopilot_videos WHERE creator_id = ? ORDER BY detected_at DESC').all(creatorId);
    return rows.map((row) => payloadJsonColumn(row)).filter((payload): payload is string => payload !== null).map(parseAutopilotVideoPayload);
  }

  getAutopilotVideo(creatorId: string, videoId: string): AutopilotVideoRecord | null {
    const payload = payloadJsonColumn(this.db.prepare('SELECT payload_json FROM autopilot_videos WHERE creator_id = ? AND video_id = ?').get(creatorId, videoId));
    return payload ? parseAutopilotVideoPayload(payload) : null;
  }

  saveAutopilotVideo(record: AutopilotVideoRecord): void {
    this.db.prepare('INSERT INTO autopilot_videos(creator_id, video_id, status, detected_at, payload_json) VALUES(?, ?, ?, ?, ?) ON CONFLICT(creator_id, video_id) DO UPDATE SET status = excluded.status, detected_at = excluded.detected_at, payload_json = excluded.payload_json').run(record.creatorId, record.videoId, record.status, record.detectedAt, JSON.stringify(record));
  }

  enqueueMissingPublicationChecks(): void {
    const rows = this.db.prepare("SELECT payload_json FROM publications WHERE status IN ('submitted', 'unconfirmed', 'scheduled') ORDER BY created_at ASC").all();
    for (const payload of rows.map((row) => payloadJsonColumn(row)).filter((value): value is string => value !== null)) {
      const record = parseJson<PublicationRecord>(payload);
      const startedAt = publicationStartedAt(record);
      if (record.status === 'unconfirmed' && (startedAt === null || Date.now() >= Date.parse(startedAt) + CHECK_WINDOW_MS)) {
        continue;
      }
      const pending = this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = 'check_publication' AND status IN ('queued', 'running') AND json_extract(payload_json, '$.payload.publicationId') = ? LIMIT 1").get(record.id);
      if (pending !== null && typeof pending === 'object') {
        continue;
      }
      if (record.status === 'scheduled' && record.scheduledFor !== null) {
        this.enqueueTask(record.jobId, 'check_publication', { publicationId: record.id }, {
          availableAt: new Date(Date.parse(record.scheduledFor) + CHECK_PUBLISH_DELAY_MS).toISOString(),
        });
        continue;
      }
      this.enqueueTask(record.jobId, 'check_publication', { publicationId: record.id });
    }
  }

  enqueueMissingHostHeadAnalyses(): void {
    const rows = this.db.prepare("SELECT payload_json FROM jobs WHERE json_extract(payload_json, '$.media') IS NOT NULL AND json_extract(payload_json, '$.hostFramingAnalyzedAt') IS NULL").all();
    for (const payload of rows.map((row) => payloadJsonColumn(row)).filter((value): value is string => value !== null)) {
      const job = parseJson<JobRecord>(payload);
      if (job.layoutProfileSnapshot.strategy !== 'fixed' || !job.layoutProfileSnapshot.panels.some((panel) => panel.role === 'host')) {
        continue;
      }
      const pending = this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = 'analyze_host' AND status IN ('queued', 'running') AND job_id = ? LIMIT 1").get(job.id);
      if (pending !== null && typeof pending === 'object') {
        continue;
      }
      this.enqueueTask(job.id, 'analyze_host', {});
    }
  }

  enqueueMissingSceneAnalyses(): void {
    const rows = this.db.prepare("SELECT payload_json FROM jobs WHERE json_extract(payload_json, '$.media') IS NOT NULL AND json_extract(payload_json, '$.layoutProfileSnapshot.strategy') = 'scenes'").all();
    for (const payload of rows.map((row) => payloadJsonColumn(row)).filter((value): value is string => value !== null)) {
      const job = parseJson<JobRecord>(payload);
      if (job.status === 'failed') {
        continue;
      }
      if (job.sceneAnalysis === 'failed' || (job.sceneAnalysis === 'done' && job.sceneTrack !== null)) {
        continue;
      }
      const pending = this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = 'analyze_scenes' AND status IN ('queued', 'running') AND job_id = ? LIMIT 1").get(job.id);
      if (pending !== null && typeof pending === 'object') {
        continue;
      }
      const ingestionFinished = job.status === 'ready' || job.status === 'awaiting_speaker';
      const markedInFlight = job.sceneAnalysis === 'queued' || job.sceneAnalysis === 'running';
      if (!ingestionFinished && !markedInFlight) {
        continue;
      }
      this.enqueueTask(job.id, 'analyze_scenes', {});
      if (job.sceneAnalysis !== 'queued') {
        job.sceneAnalysis = 'queued';
        job.sceneAnalysisError = null;
        job.updatedAt = nowIso();
        this.updateJob(job);
      }
    }
  }

  enqueueMissingCropAnalyses(): void {
    const rows = this.db.prepare("SELECT s.job_id AS job_id, s.id AS short_id FROM shorts s JOIN jobs j ON j.id = s.job_id WHERE json_extract(j.payload_json, '$.layoutProfileSnapshot.strategy') = 'scenes' AND json_extract(s.payload_json, '$.cropAnalysis') IN ('queued', 'running')").all();
    for (const entry of CropBackfillRowSchema.array().parse(rows)) {
      const pending = this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = 'analyze_crops' AND status IN ('queued', 'running') AND job_id = ? AND json_extract(payload_json, '$.payload.shortId') = ? LIMIT 1").get(entry.job_id, entry.short_id);
      if (pending !== null && typeof pending === 'object') {
        continue;
      }
      this.enqueueTask(entry.job_id, 'analyze_crops', { shortId: entry.short_id });
    }
  }

  hasActiveTask(jobId: string, kind: QueueTaskKind, shortId: string | null = null): boolean {
    const row = shortId === null
      ? this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = ? AND status IN ('queued', 'running') AND job_id = ? LIMIT 1").get(kind, jobId)
      : this.db.prepare("SELECT 1 FROM queue_tasks WHERE kind = ? AND status IN ('queued', 'running') AND job_id = ? AND json_extract(payload_json, '$.payload.shortId') = ? LIMIT 1").get(kind, jobId, shortId);
    return row !== null && typeof row === 'object';
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
    if (!publication || publication.status === 'published' || publication.status === 'failed' || publication.status === 'unconfirmed' || publication.status === 'scheduled' || publication.status === 'cancelled') {
      return;
    }
    if (publication.status === 'submitted') {
      this.enqueueTask(publication.jobId, 'check_publication', { publicationId: publication.id });
      return;
    }
    if (publication.status === 'publishing' && publication.scheduledFor !== null) {
      publication.status = 'unconfirmed';
      publication.error = "The studio stopped while sending this scheduled post. Check Mallary's queue before scheduling it again.";
      publication.updatedAt = nowIso();
      this.updatePublication(publication);
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

function migratePublicationsToV4(db: DatabaseSync): void {
  db.exec(`UPDATE publications SET payload_json = json_set(payload_json, '$.remoteUrl', json('null'), '$.submittedAt', json('null'))`);
  const migratedAt = nowIso();
  const migratedAtMs = Date.parse(migratedAt);
  const rows = db.prepare("SELECT payload_json FROM publications WHERE status = 'published' ORDER BY created_at ASC").all();
  let staggerIndex = 0;
  for (const payload of rows.map((row) => payloadJsonColumn(row)).filter((value): value is string => value !== null)) {
    const record = parseJson<PublicationRecord>(payload);
    if (record.remoteJobs.length === 0) {
      continue;
    }
    const next: PublicationRecord = { ...record, status: 'submitted', submittedAt: migratedAt, updatedAt: migratedAt };
    db.prepare('UPDATE publications SET status = ?, payload_json = ? WHERE id = ?').run(next.status, JSON.stringify(next), record.id);
    const task: QueueTask = {
      id: createId('task'),
      jobId: record.jobId,
      kind: 'check_publication',
      status: 'queued',
      payload: { publicationId: record.id },
      createdAt: migratedAt,
      availableAt: new Date(migratedAtMs + staggerIndex * 10_000).toISOString(),
      startedAt: null,
      error: null,
    };
    staggerIndex += 1;
    db.prepare('INSERT INTO queue_tasks(id, job_id, kind, status, created_at, available_at, started_at, error, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(task.id, task.jobId, task.kind, task.status, task.createdAt, task.availableAt, task.startedAt, task.error, JSON.stringify(task));
  }
}
