import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CandidateVersion, JobRecord, PendingReplyContext, QueueTask, RenderArtifact } from '../domain/model.js';
import { createId, ensureParent, nowIso, parseJson } from './util.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_callbacks (
  callback_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);

CREATE TABLE IF NOT EXISTS candidate_versions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_versions_job ON candidate_versions(job_id, version_number);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_renders_job ON renders(job_id, created_at);

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
CREATE INDEX IF NOT EXISTS idx_queue_tasks_status_created ON queue_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS pending_replies (
  chat_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS callback_tokens (
  token TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_job ON actions(job_id, created_at);
`;

export interface CallbackTokenPayload {
  kind: 'pick_speaker' | 'approve_draft' | 'request_revision' | 'reject_candidate' | 'render_candidate' | 'publish_instagram' | 'publish_everywhere';
  jobId: string;
  candidateId?: string;
  candidateVersionId?: string;
  renderId?: string;
  speakerId?: string;
  force?: boolean;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export class ShortsStore {
  constructor(private readonly db: DatabaseSync) {}

  static async open(path: string): Promise<ShortsStore> {
    await ensureParent(path);
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA_SQL);
    ensureColumn(db, 'queue_tasks', 'available_at', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_queue_tasks_status_available_created ON queue_tasks(status, available_at, created_at)');
    return new ShortsStore(db);
  }

  close(): void {
    this.db.close();
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  hasProcessedUpdate(updateId: number): boolean {
    const row = this.db.prepare('SELECT 1 FROM processed_updates WHERE update_id = ?').get(updateId) as { 1: number } | undefined;
    return Boolean(row);
  }

  markProcessedUpdate(updateId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_updates(update_id, created_at) VALUES(?, ?)').run(updateId, nowIso());
  }

  hasProcessedCallback(callbackId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM processed_callbacks WHERE callback_id = ?').get(callbackId) as { 1: number } | undefined;
    return Boolean(row);
  }

  markProcessedCallback(callbackId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO processed_callbacks(callback_id, created_at) VALUES(?, ?)').run(callbackId, nowIso());
  }

  createJob(job: JobRecord): void {
    this.db.prepare('INSERT INTO jobs(id, chat_id, user_id, status, updated_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)').run(job.id, job.operatorChatId, job.operatorUserId, job.status, job.updatedAt, JSON.stringify(job));
  }

  updateJob(job: JobRecord): void {
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ?, payload_json = ? WHERE id = ?').run(job.status, job.updatedAt, JSON.stringify(job), job.id);
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(jobId) as { payload_json: string } | undefined;
    return row ? parseJson<JobRecord>(row.payload_json) : null;
  }

  listJobs(limit = 10): JobRecord[] {
    const rows = this.db.prepare('SELECT payload_json FROM jobs ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<JobRecord>(row.payload_json));
  }

  latestJobForChat(chatId: string): JobRecord | null {
    const row = this.db.prepare('SELECT payload_json FROM jobs WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1').get(chatId) as { payload_json: string } | undefined;
    return row ? parseJson<JobRecord>(row.payload_json) : null;
  }

  saveCandidateVersion(version: CandidateVersion): void {
    this.db.prepare('INSERT INTO candidate_versions(id, job_id, version_number, created_at, payload_json) VALUES(?, ?, ?, ?, ?)').run(version.id, version.jobId, version.number, version.createdAt, JSON.stringify(version));
  }

  updateCandidateVersion(version: CandidateVersion): void {
    this.db.prepare('UPDATE candidate_versions SET payload_json = ? WHERE id = ?').run(JSON.stringify(version), version.id);
  }

  getCandidateVersion(versionId: string): CandidateVersion | null {
    const row = this.db.prepare('SELECT payload_json FROM candidate_versions WHERE id = ?').get(versionId) as { payload_json: string } | undefined;
    return row ? parseJson<CandidateVersion>(row.payload_json) : null;
  }

  latestCandidateVersionNumber(jobId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version_number), 0) AS value FROM candidate_versions WHERE job_id = ?').get(jobId) as { value: number };
    return row.value;
  }

  saveRender(render: RenderArtifact): void {
    this.db.prepare('INSERT INTO renders(id, job_id, candidate_id, kind, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)').run(render.id, render.jobId, render.candidateId, render.kind, render.createdAt, JSON.stringify(render));
  }

  updateRender(render: RenderArtifact): void {
    this.db.prepare('UPDATE renders SET payload_json = ? WHERE id = ?').run(JSON.stringify(render), render.id);
  }

  getRender(renderId: string): RenderArtifact | null {
    const row = this.db.prepare('SELECT payload_json FROM renders WHERE id = ?').get(renderId) as { payload_json: string } | undefined;
    return row ? parseJson<RenderArtifact>(row.payload_json) : null;
  }

  listRendersForJob(jobId: string): RenderArtifact[] {
    const rows = this.db.prepare('SELECT payload_json FROM renders WHERE job_id = ? ORDER BY created_at ASC').all(jobId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<RenderArtifact>(row.payload_json));
  }

  hasTaskForRender(jobId: string, kind: QueueTask['kind'], renderId: string, statuses: Array<QueueTask['status']>): boolean {
    const rows = this.db.prepare('SELECT payload_json FROM queue_tasks WHERE job_id = ? AND kind = ? ORDER BY created_at DESC').all(jobId, kind) as Array<{ payload_json: string }>;
    return rows
      .map((row) => parseJson<QueueTask>(row.payload_json))
      .some((task) => task.status && statuses.includes(task.status) && task.payload.renderId === renderId);
  }

  hasTaskForRenderPlatform(jobId: string, kind: QueueTask['kind'], renderId: string, platform: string, statuses: Array<QueueTask['status']>): boolean {
    const rows = this.db.prepare('SELECT payload_json FROM queue_tasks WHERE job_id = ? AND kind = ? ORDER BY created_at DESC').all(jobId, kind) as Array<{ payload_json: string }>;
    return rows
      .map((row) => parseJson<QueueTask>(row.payload_json))
      .some((task) => task.status && statuses.includes(task.status) && task.payload.renderId === renderId && task.payload.platform === platform);
  }

  hasTaskForJob(jobId: string, kind: QueueTask['kind'], statuses: Array<QueueTask['status']>): boolean {
    const row = this.db.prepare('SELECT 1 FROM queue_tasks WHERE job_id = ? AND kind = ? AND status IN (?, ?, ?) LIMIT 1').get(
      jobId,
      kind,
      statuses[0] ?? '',
      statuses[1] ?? '',
      statuses[2] ?? '',
    ) as { 1: number } | undefined;
    return Boolean(row);
  }

  enqueueTask(jobId: string, kind: QueueTask['kind'], payload: Record<string, unknown>, options: { availableAt?: string | null } = {}): QueueTask {
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

  claimNextTask(jobId?: string): QueueTask | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = nowIso();
      const row = (jobId
        ? this.db.prepare("SELECT payload_json FROM queue_tasks WHERE status = 'queued' AND job_id = ? AND (available_at IS NULL OR available_at <= ?) ORDER BY COALESCE(available_at, created_at) ASC, created_at ASC LIMIT 1").get(jobId, now)
        : this.db.prepare("SELECT payload_json FROM queue_tasks WHERE status = 'queued' AND (available_at IS NULL OR available_at <= ?) ORDER BY COALESCE(available_at, created_at) ASC, created_at ASC LIMIT 1").get(now)) as { payload_json: string } | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const task = parseJson<QueueTask>(row.payload_json);
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

  requeueRunningTasks(): void {
    const rows = this.db.prepare("SELECT payload_json FROM queue_tasks WHERE status = 'running'").all() as Array<{ payload_json: string }>;
    for (const row of rows) {
      const task = parseJson<QueueTask>(row.payload_json);
      task.status = 'queued';
      task.startedAt = null;
      task.availableAt = null;
      task.error = null;
      this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, started_at = NULL, error = NULL, payload_json = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
    }
  }

  completeTask(task: QueueTask): void {
    task.status = 'done';
    task.availableAt = null;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, payload_json = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
  }

  failTask(task: QueueTask, errorMessage: string): void {
    task.status = 'failed';
    task.availableAt = null;
    task.error = errorMessage;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = NULL, error = ?, payload_json = ? WHERE id = ?').run(task.status, task.error, JSON.stringify(task), task.id);
  }

  rescheduleTask(task: QueueTask, availableAt: string, errorMessage: string | null = null): void {
    task.status = 'queued';
    task.availableAt = availableAt;
    task.startedAt = null;
    task.error = errorMessage;
    this.db.prepare('UPDATE queue_tasks SET status = ?, available_at = ?, started_at = NULL, error = ?, payload_json = ? WHERE id = ?').run(task.status, task.availableAt, task.error, JSON.stringify(task), task.id);
  }

  setPendingReply(context: PendingReplyContext): void {
    this.db.prepare('INSERT INTO pending_replies(chat_id, payload_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at').run(context.chatId, JSON.stringify(context), nowIso());
  }

  getPendingReply(chatId: string): PendingReplyContext | null {
    const row = this.db.prepare('SELECT payload_json FROM pending_replies WHERE chat_id = ?').get(chatId) as { payload_json: string } | undefined;
    return row ? parseJson<PendingReplyContext>(row.payload_json) : null;
  }

  clearPendingReply(chatId: string): void {
    this.db.prepare('DELETE FROM pending_replies WHERE chat_id = ?').run(chatId);
  }

  createCallbackToken(payload: CallbackTokenPayload): string {
    const token = createId('cb');
    this.db.prepare('INSERT INTO callback_tokens(token, payload_json, created_at) VALUES(?, ?, ?)').run(token, JSON.stringify(payload), nowIso());
    return token;
  }

  getCallbackToken(token: string): CallbackTokenPayload | null {
    const row = this.db.prepare('SELECT payload_json FROM callback_tokens WHERE token = ?').get(token) as { payload_json: string } | undefined;
    return row ? parseJson<CallbackTokenPayload>(row.payload_json) : null;
  }

  hasAction(jobId: string, kind: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM actions WHERE job_id = ? AND kind = ? LIMIT 1').get(jobId, kind) as { 1: number } | undefined;
    return Boolean(row);
  }

  appendAction(jobId: string, kind: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO actions(id, job_id, kind, created_at, payload_json) VALUES(?, ?, ?, ?, ?)').run(createId('act'), jobId, kind, nowIso(), JSON.stringify(payload));
  }
}
