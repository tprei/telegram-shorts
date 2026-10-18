import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULE_LIMITS, freePostingSlots, scheduledAtProblem, suggestPostingSlots, zonedDateParts, zonedTimeToUtc } from '../src/domain/schedule.js';
import type { PostingSchedule } from '../src/domain/model.js';

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
