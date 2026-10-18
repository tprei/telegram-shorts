import { publicationStartedAt, type AutopilotShortState, type AutopilotVideoRecord, type CreatorAutopilotConfig, type ExportRecord, type JobRecord, type PublicationRecord, type PublicationStatus, type ShortRecord } from './model.js';

export const AUTOPILOT_POLL_INTERVAL_MS = 15 * 60_000;
export const AUTOPILOT_TICK_MS = 60_000;
export const AUTOPILOT_MAX_JOB_RETRIES = 2;
export const AUTOPILOT_RETRY_DELAY_MS = 30 * 60_000;
export const AUTOPILOT_LIVE_STATUSES_TO_SKIP: Record<string, true> = { is_upcoming: true, is_live: true };

const HOUR_MS = 3_600_000;

const BOOKED_PUBLICATION_STATUSES: Partial<Record<PublicationStatus, true>> = {
  queued: true,
  publishing: true,
  submitted: true,
  scheduled: true,
  deferred: true,
  published: true,
  unconfirmed: true,
};

export function isAutopilotEligibleUpload(upload: { durationSeconds: number | null; liveStatus: string | null }, config: CreatorAutopilotConfig): boolean {
  if (upload.durationSeconds === null || upload.durationSeconds < config.minVideoSeconds) {
    return false;
  }
  return upload.liveStatus === null || !(upload.liveStatus in AUTOPILOT_LIVE_STATUSES_TO_SKIP);
}

export interface AutopilotShortPlan {
  short: ShortRecord;
  state: AutopilotShortState;
  reason: string | null;
  scheduledFor: string | null;
  readyExportId: string | null;
  needsCopy: boolean;
  needsExport: boolean;
}

export function exportMatchesShort(record: ExportRecord, short: ShortRecord, job: JobRecord): boolean {
  return record.editRevision === short.editRevision
    && record.title === short.title
    && record.transcriptRevision === job.transcriptRevision
    && JSON.stringify(record.hostFraming) === JSON.stringify(job.hostFraming);
}

interface CandidateAssessment {
  short: ShortRecord;
  publications: PublicationRecord[];
  used: boolean;
  ineligibilityReason: string | null;
}

function assessCandidate(short: ShortRecord, publications: PublicationRecord[], job: JobRecord, exports: ExportRecord[]): CandidateAssessment {
  if (publications.length > 0) {
    return { short, publications, used: true, ineligibilityReason: null };
  }
  if (short.status !== 'active') {
    return { short, publications, used: false, ineligibilityReason: 'Rejected in the studio' };
  }
  if (short.risk === 'high') {
    return { short, publications, used: false, ineligibilityReason: 'High risk: review it yourself' };
  }
  if (short.cropAnalysis === 'failed') {
    return { short, publications, used: false, ineligibilityReason: 'Crop analysis failed' };
  }
  const current = exports
    .filter((record) => record.shortId === short.id && exportMatchesShort(record, short, job))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (current.at(-1)?.status === 'failed') {
    return { short, publications, used: false, ineligibilityReason: 'Export failed' };
  }
  return { short, publications, used: false, ineligibilityReason: null };
}

function planSelectedCandidate(assessment: CandidateAssessment, video: AutopilotVideoRecord, config: CreatorAutopilotConfig, job: JobRecord, exports: ExportRecord[], now: Date, hasHostPanel: boolean): AutopilotShortPlan {
  const short = assessment.short;
  if (assessment.used) {
    const live = assessment.publications.filter((publication) => BOOKED_PUBLICATION_STATUSES[publication.status] === true);
    if (live.length > 0) {
      const starts = live
        .map(publicationStartedAt)
        .filter((value): value is string => value !== null)
        .sort();
      return { short, state: 'booked', reason: null, scheduledFor: starts[0] ?? null, readyExportId: null, needsCopy: false, needsExport: false };
    }
    if (assessment.publications.some((publication) => publication.status === 'cancelled')) {
      return { short, state: 'skipped', reason: 'Cancelled in the studio', scheduledFor: null, readyExportId: null, needsCopy: false, needsExport: false };
    }
    const firstError = assessment.publications.find((publication) => publication.error !== null)?.error;
    return { short, state: 'skipped', reason: `Posting failed: ${firstError ?? 'unknown error'}`, scheduledFor: null, readyExportId: null, needsCopy: false, needsExport: false };
  }
  const idle: Omit<AutopilotShortPlan, 'state'> = { short, reason: null, scheduledFor: null, readyExportId: null, needsCopy: false, needsExport: false };
  if (now.getTime() > Date.parse(video.detectedAt) + config.maxShortAgeHours * HOUR_MS) {
    return { ...idle, state: 'expired' };
  }
  const waitingOnCrops = short.cropAnalysis === 'queued' || short.cropAnalysis === 'running';
  if (waitingOnCrops || (hasHostPanel && job.hostFramingAnalyzedAt === null)) {
    return { ...idle, state: 'waiting' };
  }
  const current = exports
    .filter((record) => record.shortId === short.id && exportMatchesShort(record, short, job))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let readyExportId: string | null = null;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index].status === 'ready') {
      readyExportId = current[index].id;
      break;
    }
  }
  if (short.publishCopy === null || readyExportId === null) {
    return {
      ...idle,
      state: 'exporting',
      needsCopy: short.publishCopy === null,
      needsExport: !current.some((record) => record.status === 'queued' || record.status === 'rendering' || record.status === 'ready'),
    };
  }
  return { ...idle, state: 'ready', readyExportId };
}

export function autopilotShortPlan(input: {
  video: AutopilotVideoRecord;
  job: JobRecord;
  shorts: ShortRecord[];
  exports: ExportRecord[];
  publications: PublicationRecord[];
  config: CreatorAutopilotConfig;
  now: Date;
  hasHostPanel: boolean;
}): AutopilotShortPlan[] {
  if (input.job.status !== 'ready') {
    return [];
  }
  const candidates = input.shorts
    .filter((short) => short.origin === 'planner')
    .sort((a, b) => a.rank - b.rank);
  const publicationsByShort: Record<string, PublicationRecord[]> = {};
  for (const publication of input.publications) {
    (publicationsByShort[publication.shortId] ??= []).push(publication);
  }
  const assessments = candidates.map((short) => assessCandidate(short, publicationsByShort[short.id] ?? [], input.job, input.exports));

  const nonUsedQuota = Math.max(0, input.config.shortsPerVideo - assessments.filter((assessment) => assessment.used).length);
  let selectedNonUsed = 0;
  let lastSelectedIndex = -1;
  const selected = assessments.map((assessment, index) => {
    if (assessment.used || (assessment.ineligibilityReason === null && selectedNonUsed < nonUsedQuota)) {
      if (!assessment.used) {
        selectedNonUsed += 1;
      }
      lastSelectedIndex = index;
      return true;
    }
    return false;
  });

  const plans: AutopilotShortPlan[] = [];
  assessments.forEach((assessment, index) => {
    if (!selected[index]) {
      if (assessment.ineligibilityReason !== null && index < lastSelectedIndex) {
        plans.push({ short: assessment.short, state: 'skipped', reason: assessment.ineligibilityReason, scheduledFor: null, readyExportId: null, needsCopy: false, needsExport: false });
      }
      return;
    }
    plans.push(planSelectedCandidate(assessment, input.video, input.config, input.job, input.exports, input.now, input.hasHostPanel));
  });
  return plans;
}

export function orderReadyShorts(entries: Array<{ video: AutopilotVideoRecord; plan: AutopilotShortPlan }>): Array<{ video: AutopilotVideoRecord; plan: AutopilotShortPlan }> {
  return [...entries].sort((a, b) => {
    const byDetection = Date.parse(b.video.detectedAt) - Date.parse(a.video.detectedAt);
    if (byDetection !== 0) {
      return byDetection;
    }
    return a.plan.short.rank - b.plan.short.rank;
  });
}
