import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULE_LIMITS, accountSlotProblem, accountTakenSlots, freePostingSlots, scheduledAtProblem, suggestPostingSlots, zonedDateParts, zonedTimeToUtc } from '../src/domain/schedule.js';
import type { PostingSchedule, PublicationRecord, PublishingAccount } from '../src/domain/model.js';

const MINUTE_MS = 60_000;
const SAO_PAULO = 'America/Sao_Paulo';
const LONDON = 'Europe/London';
const SCHEDULE: PostingSchedule = { timeZone: SAO_PAULO, slots: ['12:00', '19:00', '21:00'] };

function saoPauloInstant(day: number, hour: number, minute = 0): Date {
  return zonedTimeToUtc({ year: 2026, month: 10, day, hour, minute, timeZone: SAO_PAULO });
}

function isoList(dates: readonly Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

test('zonedTimeToUtc converts São Paulo wall time to UTC', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 18, hour: 12, minute: 0, timeZone: SAO_PAULO }).toISOString(), '2026-10-18T15:00:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 18, hour: 21, minute: 30, timeZone: SAO_PAULO }).toISOString(), '2026-10-19T00:30:00.000Z');
});

test('zonedTimeToUtc stays correct across the Europe/London DST change', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 24, hour: 12, minute: 0, timeZone: LONDON }).toISOString(), '2026-10-24T11:00:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 0, minute: 30, timeZone: LONDON }).toISOString(), '2026-10-24T23:30:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, timeZone: LONDON }).toISOString(), '2026-10-25T01:30:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 12, minute: 0, timeZone: LONDON }).toISOString(), '2026-10-25T12:00:00.000Z');
});

test('zonedDateParts reads the wall clock of the zone', () => {
  assert.deepEqual(zonedDateParts(new Date('2026-10-24T12:30:00Z'), LONDON), { year: 2026, month: 10, day: 24, hour: 13, minute: 30 });
  assert.deepEqual(zonedDateParts(new Date('2026-10-25T12:30:00Z'), LONDON), { year: 2026, month: 10, day: 25, hour: 12, minute: 30 });
  assert.deepEqual(zonedDateParts(new Date('2026-10-19T00:30:00Z'), SAO_PAULO), { year: 2026, month: 10, day: 18, hour: 21, minute: 30 });
});

test('zonedTimeToUtc resolves New York and Sydney DST-change days', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 3, minute: 0, timeZone: 'America/New_York' }).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 3, hour: 21, minute: 0, timeZone: 'Australia/Sydney' }).toISOString(), '2026-10-03T11:00:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 4, hour: 12, minute: 0, timeZone: 'Australia/Sydney' }).toISOString(), '2026-10-04T01:00:00.000Z');
});

test('freePostingSlots caps each day at the schedule slot count including taken posts', () => {
  const instant = (hour: number, minute = 0): Date => zonedTimeToUtc({ year: 2026, month: 10, day: 20, hour, minute, timeZone: SAO_PAULO });
  const free = freePostingSlots({ schedule: SCHEDULE, from: instant(0), to: instant(23, 59), taken: [instant(16, 30)] });
  assert.deepEqual(isoList(free), [
    '2026-10-20T15:00:00.000Z',
    '2026-10-20T22:00:00.000Z',
  ]);
});

test('freePostingSlots keeps only slot instants inside the inclusive bounds', () => {
  const from = saoPauloInstant(18, 19);
  const to = saoPauloInstant(19, 12);
  assert.deepEqual(isoList(freePostingSlots({ schedule: SCHEDULE, from, to, taken: [] })), [
    saoPauloInstant(18, 19).toISOString(),
    saoPauloInstant(18, 21).toISOString(),
    saoPauloInstant(19, 12).toISOString(),
  ]);
  const afterFirstSlot = freePostingSlots({ schedule: SCHEDULE, from: new Date(from.getTime() + 1), to, taken: [] });
  assert.deepEqual(isoList(afterFirstSlot), [saoPauloInstant(18, 21).toISOString(), saoPauloInstant(19, 12).toISOString()]);
  const beforeLastSlot = freePostingSlots({ schedule: SCHEDULE, from, to: new Date(to.getTime() - 1), taken: [] });
  assert.deepEqual(isoList(beforeLastSlot), [saoPauloInstant(18, 19).toISOString(), saoPauloInstant(18, 21).toISOString()]);
});

test('freePostingSlots skips slots within the spacing of taken times', () => {
  const from = saoPauloInstant(18, 12);
  const to = saoPauloInstant(19, 12);
  const taken = [saoPauloInstant(18, 19, 30)];
  assert.deepEqual(isoList(freePostingSlots({ schedule: SCHEDULE, from, to, taken })), [
    saoPauloInstant(18, 12).toISOString(),
    saoPauloInstant(19, 12).toISOString(),
  ]);
});

test('freePostingSlots allows slots exactly at the spacing boundary', () => {
  const from = saoPauloInstant(18, 12);
  const to = saoPauloInstant(19, 12);
  const takenAtSpacing = [saoPauloInstant(18, 21)];
  const slots = freePostingSlots({ schedule: SCHEDULE, from, to, taken: takenAtSpacing });
  assert.deepEqual(isoList(slots), [
    saoPauloInstant(18, 12).toISOString(),
    saoPauloInstant(18, 19).toISOString(),
    saoPauloInstant(19, 12).toISOString(),
  ]);
});

test('suggestPostingSlots skips taken slots beyond the lead window', () => {
  const now = saoPauloInstant(18, 12, 1);
  const taken = [saoPauloInstant(18, 19)];
  const slots = suggestPostingSlots({ now, taken, count: 3, schedule: SCHEDULE });
  assert.deepEqual(isoList(slots), [
    saoPauloInstant(18, 21).toISOString(),
    saoPauloInstant(19, 12).toISOString(),
    saoPauloInstant(19, 19).toISOString(),
  ]);
});

test('suggestPostingSlots skips slots inside the lead window', () => {
  const now = saoPauloInstant(18, 18, 50);
  const slots = suggestPostingSlots({ now, taken: [], count: 2, schedule: SCHEDULE });
  assert.deepEqual(isoList(slots), [saoPauloInstant(18, 21).toISOString(), saoPauloInstant(19, 12).toISOString()]);
});

test('scheduledAtProblem enforces the schedule lead window', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const minLead = new Date(now.getTime() + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS);
  const maxLead = new Date(now.getTime() + SCHEDULE_LIMITS.maxLeadDays * 24 * 60 * MINUTE_MS);
  assert.equal(scheduledAtProblem(new Date(minLead.getTime() - 1), now), 'Pick a time at least 15 minutes from now.');
  assert.equal(scheduledAtProblem(minLead, now), null);
  assert.equal(scheduledAtProblem(new Date(now.getTime() + 30 * MINUTE_MS), now), null);
  assert.equal(scheduledAtProblem(maxLead, now), null);
  assert.equal(scheduledAtProblem(new Date(maxLead.getTime() + 1), now), 'Pick a time within the next 60 days.');
});

test('scheduledAtProblem rejects invalid dates', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  assert.equal(scheduledAtProblem(new Date('not a date'), now), 'Pick a valid date and time.');
  assert.equal(scheduledAtProblem(new Date(Number.NaN), now), 'Pick a valid date and time.');
});

const MIX_ACCOUNT: PublishingAccount = {
  id: 'mix',
  displayName: 'Mix',
  schedule: { timeZone: SAO_PAULO, slots: ['12:00', '19:00', '21:00'] },
  platforms: ['instagram', 'tiktok'],
  mallaryProfileId: null,
  buffer: false,
  cover: null,
};

let accountPublicationCounter = 0;

function accountPublication(overrides: Partial<PublicationRecord>): PublicationRecord {
  accountPublicationCounter += 1;
  return {
    id: `acct_pub_${accountPublicationCounter}`,
    jobId: 'job_mix_a',
    shortId: 'short_1',
    exportId: 'export_1',
    platform: 'instagram',
    status: 'scheduled',
    forced: false,
    provider: 'mallary',
    batchId: null,
    remoteJobs: [],
    remoteUrl: null,
    submittedAt: null,
    scheduledFor: null,
    error: null,
    availableAt: null,
    createdAt: '2026-10-18T12:00:00.000Z',
    updatedAt: '2026-10-18T12:00:00.000Z',
    ...overrides,
  };
}

const CAPACITY_JOBS = [
  { id: 'job_boni', accountId: 'cortes_do_boni' },
  { id: 'job_mix_a', accountId: 'mix' },
  { id: 'job_mix_b', accountId: 'mix' },
];

test('account capacity dedupes platforms and includes early same-day posts', () => {
  const publications = [
    accountPublication({ jobId: 'job_mix_a', shortId: 'short_1', platform: 'instagram', scheduledFor: '2026-10-18T15:00:00.000Z' }),
    accountPublication({ jobId: 'job_mix_b', shortId: 'short_1', platform: 'tiktok', scheduledFor: '2026-10-18T15:00:00.000Z' }),
    accountPublication({ jobId: 'job_boni', shortId: 'short_2', platform: 'instagram', scheduledFor: '2026-10-18T15:30:00.000Z' }),
    accountPublication({ jobId: 'job_mix_a', shortId: 'short_3', platform: 'instagram', status: 'failed', scheduledFor: '2026-10-18T16:00:00.000Z' }),
  ];
  const from = new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 18, hour: 0, minute: 0, timeZone: SAO_PAULO }).getTime() - 120 * MINUTE_MS);
  assert.equal(from.toISOString(), '2026-10-18T01:00:00.000Z');
  const taken = accountTakenSlots({ accountId: 'mix', jobs: CAPACITY_JOBS, publications, from, excludeShortId: null });
  assert.deepEqual(isoList(taken), ['2026-10-18T15:00:00.000Z']);
  const withoutCurrentShort = accountTakenSlots({ accountId: 'mix', jobs: CAPACITY_JOBS, publications, from, excludeShortId: 'short_1' });
  assert.deepEqual(isoList(withoutCurrentShort), []);
  const boniTaken = accountTakenSlots({ accountId: 'cortes_do_boni', jobs: CAPACITY_JOBS, publications, from, excludeShortId: null });
  assert.deepEqual(isoList(boniTaken), ['2026-10-18T15:30:00.000Z']);
  const submittedFallback = accountTakenSlots({
    accountId: 'mix',
    jobs: CAPACITY_JOBS,
    publications: [
      accountPublication({ shortId: 'short_9', status: 'published', scheduledFor: null, submittedAt: null, availableAt: '2026-10-18T14:00:00.000Z', createdAt: '2026-10-18T13:30:00.000Z' }),
    ],
    from,
    excludeShortId: null,
  });
  assert.deepEqual(isoList(submittedFallback), ['2026-10-18T14:00:00.000Z']);

  const morning = [saoPauloInstant(18, 12)];
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(18, 19), taken: morning }), null);
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(18, 14), taken: morning }), null);
  const fullDay = [saoPauloInstant(18, 12), saoPauloInstant(18, 19), saoPauloInstant(18, 21)];
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(18, 15), taken: fullDay }), 'daily_cap');
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(19, 12), taken: fullDay }), null);
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(18, 13), taken: morning }), 'spacing');
});

test('different accounts may share an instant but creators of one account cannot', () => {
  const publications = [
    accountPublication({ jobId: 'job_mix_a', shortId: 'short_a', platform: 'instagram', scheduledFor: '2026-10-18T15:00:00.000Z' }),
    accountPublication({ jobId: 'job_boni', shortId: 'short_b', platform: 'instagram', scheduledFor: '2026-10-18T15:00:00.000Z' }),
    accountPublication({ jobId: 'job_mix_b', shortId: 'short_c', platform: 'tiktok', scheduledFor: '2026-10-18T16:00:00.000Z' }),
  ];
  const from = new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 18, hour: 0, minute: 0, timeZone: SAO_PAULO }).getTime() - 120 * MINUTE_MS);
  const mixTaken = accountTakenSlots({ accountId: 'mix', jobs: CAPACITY_JOBS, publications, from, excludeShortId: null });
  assert.deepEqual(isoList(mixTaken), ['2026-10-18T15:00:00.000Z', '2026-10-18T16:00:00.000Z']);
  const boniTaken = accountTakenSlots({ accountId: 'cortes_do_boni', jobs: CAPACITY_JOBS, publications, from, excludeShortId: null });
  assert.deepEqual(isoList(boniTaken), ['2026-10-18T15:00:00.000Z']);
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: saoPauloInstant(18, 12), taken: mixTaken }), 'spacing');

  const beforeMidnight = saoPauloInstant(18, 23);
  const afterMidnight = new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 19, hour: 0, minute: 30, timeZone: SAO_PAULO }).getTime());
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: afterMidnight, taken: [beforeMidnight] }), 'spacing');
  assert.equal(accountSlotProblem({ account: MIX_ACCOUNT, at: afterMidnight, taken: [saoPauloInstant(18, 12), saoPauloInstant(18, 19), saoPauloInstant(18, 21)] }), null);
});
