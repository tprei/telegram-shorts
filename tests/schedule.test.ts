import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULE_LIMITS, scheduledAtProblem, suggestPostingSlots } from '../src/domain/schedule.js';

const MINUTE_MS = 60_000;

function localDate(base: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0);
}

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

test('suggestPostingSlots skips slots inside the lead window and rolls across days', () => {
  const now = new Date(2026, 9, 18, 13, 0);
  const slots = suggestPostingSlots({ now, taken: [], count: 4 });
  assert.deepEqual(slots, [
    localDate(now, 0, 19, 0),
    localDate(now, 0, 21, 0),
    localDate(now, 1, 12, 0),
    localDate(now, 1, 19, 0),
  ]);
});

test('suggestPostingSlots skips slots within the spacing of taken times', () => {
  const now = new Date(2026, 9, 18, 6, 0);
  const taken = [localDate(now, 0, 12, 30), localDate(now, 0, 20, 45)];
  const slots = suggestPostingSlots({ now, taken, count: 4 });
  assert.deepEqual(slots, [
    localDate(now, 1, 12, 0),
    localDate(now, 1, 19, 0),
    localDate(now, 1, 21, 0),
    localDate(now, 2, 12, 0),
  ]);
});

test('suggestPostingSlots allows slots exactly at the spacing boundary', () => {
  const now = new Date(2026, 9, 18, 6, 0);
  const taken = [localDate(now, 0, 21, 0)];
  const slots = suggestPostingSlots({ now, taken, count: 3 });
  assert.deepEqual(slots, [
    localDate(now, 0, 12, 0),
    localDate(now, 0, 19, 0),
    localDate(now, 1, 12, 0),
  ]);
});

test('scheduledAtProblem rejects invalid dates', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  assert.equal(scheduledAtProblem(new Date('not a date'), now), 'Pick a valid date and time.');
  assert.equal(scheduledAtProblem(new Date(Number.NaN), now), 'Pick a valid date and time.');
});

test('suggestPostingSlots rolls to the next day after the last slot', () => {
  const now = new Date(2026, 9, 18, 21, 30);
  const slots = suggestPostingSlots({ now, taken: [], count: 2 });
  assert.deepEqual(slots, [
    localDate(now, 1, 12, 0),
    localDate(now, 1, 19, 0),
  ]);
});
