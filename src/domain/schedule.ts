import type { PostingSchedule, PublicationRecord, PublishingAccount } from './model.js';

export const SCHEDULE_LIMITS = { minLeadMinutes: 15, maxLeadDays: 60, slotSpacingMinutes: 120 } as const;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface ZonedDateTimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedFields(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const fields: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      fields[part.type] = Number(part.value);
    }
  }
  return fields;
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const fields = zonedFields(new Date(instant), timeZone);
  return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) - instant;
}

export function zonedTimeToUtc(input: { year: number; month: number; day: number; hour: number; minute: number; timeZone: string }): Date {
  const guess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  const firstPass = guess - zoneOffsetMs(guess, input.timeZone);
  return new Date(guess - zoneOffsetMs(firstPass, input.timeZone));
}

export function zonedDateParts(date: Date, timeZone: string): ZonedDateTimeFields {
  const fields = zonedFields(date, timeZone);
  return { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute };
}

export function scheduledAtProblem(scheduledAt: Date, now: Date): string | null {
  if (Number.isNaN(scheduledAt.getTime())) {
    return 'Pick a valid date and time.';
  }
  if (scheduledAt.getTime() < now.getTime() + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS) {
    return 'Pick a time at least 15 minutes from now.';
  }
  if (scheduledAt.getTime() > now.getTime() + SCHEDULE_LIMITS.maxLeadDays * DAY_MS) {
    return 'Pick a time within the next 60 days.';
  }
  return null;
}

export function freePostingSlots(input: { schedule: PostingSchedule; from: Date; to: Date; taken: readonly Date[] }): Date[] {
  const slots = [...input.schedule.slots]
    .sort((a, b) => a.localeCompare(b))
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot) && Number(slot.slice(0, 2)) <= 23 && Number(slot.slice(3, 5)) <= 59);
  const spacingMs = SCHEDULE_LIMITS.slotSpacingMinutes * MINUTE_MS;
  const dailyCap = input.schedule.slots.length;
  const timeZone = input.schedule.timeZone;
  const takenDayKeys = input.taken.map((taken) => localDayKey(taken, timeZone));
  const startDate = zonedDateParts(input.from, timeZone);
  const free: Date[] = [];
  const returnedDayKeys: string[] = [];
  for (let dayOffset = 0; slots.length > 0; dayOffset += 1) {
    let reachedEnd = false;
    for (const slot of slots) {
      const instant = zonedTimeToUtc({
        year: startDate.year,
        month: startDate.month,
        day: startDate.day + dayOffset,
        hour: Number(slot.slice(0, 2)),
        minute: Number(slot.slice(3, 5)),
        timeZone,
      }).getTime();
      if (instant > input.to.getTime()) {
        reachedEnd = true;
        break;
      }
      if (instant < input.from.getTime()) {
        continue;
      }
      const tooCloseToTaken = input.taken.some((taken) => Math.abs(taken.getTime() - instant) < spacingMs);
      const tooCloseToReturned = free.some((returned) => Math.abs(returned.getTime() - instant) < spacingMs);
      if (tooCloseToTaken || tooCloseToReturned) {
        continue;
      }
      const day = localDayKey(new Date(instant), timeZone);
      const dayCount = takenDayKeys.filter((key) => key === day).length + returnedDayKeys.filter((key) => key === day).length;
      if (dayCount >= dailyCap) {
        continue;
      }
      free.push(new Date(instant));
      returnedDayKeys.push(day);
    }
    if (reachedEnd) {
      break;
    }
  }
  return free;
}

export function suggestPostingSlots(input: { now: Date; taken: readonly Date[]; count: number; schedule: PostingSchedule }): Date[] {
  return freePostingSlots({
    schedule: input.schedule,
    from: new Date(input.now.getTime() + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS),
    to: new Date(input.now.getTime() + SCHEDULE_LIMITS.maxLeadDays * DAY_MS),
    taken: input.taken,
  }).slice(0, input.count);
}

function localDayKey(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function accountTakenSlots(input: {
  accountId: string;
  jobs: readonly { id: string; accountId: string | null }[];
  publications: readonly PublicationRecord[];
  from: Date;
  excludeShortId: string | null;
}): Date[] {
  const accountByJob = new Map(input.jobs.map((job) => [job.id, job.accountId]));
  const earliestByShort = new Map<string, Date>();
  for (const publication of input.publications) {
    if (publication.status === 'failed' || publication.status === 'cancelled') {
      continue;
    }
    if (publication.shortId === input.excludeShortId) {
      continue;
    }
    if (accountByJob.get(publication.jobId) !== input.accountId) {
      continue;
    }
    const startedAt = publication.scheduledFor ?? publication.submittedAt ?? publication.availableAt ?? publication.createdAt;
    const start = new Date(startedAt);
    if (start.getTime() < input.from.getTime()) {
      continue;
    }
    const previous = earliestByShort.get(publication.shortId);
    if (previous === undefined || start.getTime() < previous.getTime()) {
      earliestByShort.set(publication.shortId, start);
    }
  }
  return [...earliestByShort.values()].sort((left, right) => left.getTime() - right.getTime());
}

export function accountSlotProblem(input: { account: PublishingAccount; at: Date; taken: readonly Date[] }): 'spacing' | 'daily_cap' | null {
  const spacingMs = SCHEDULE_LIMITS.slotSpacingMinutes * MINUTE_MS;
  if (input.taken.some((taken) => Math.abs(taken.getTime() - input.at.getTime()) < spacingMs)) {
    return 'spacing';
  }
  const dayKey = localDayKey(input.at, input.account.schedule.timeZone);
  const sameDayCount = input.taken.filter((taken) => localDayKey(taken, input.account.schedule.timeZone) === dayKey).length;
  return sameDayCount >= input.account.schedule.slots.length ? 'daily_cap' : null;
}
