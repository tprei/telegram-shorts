export const SCHEDULE_LIMITS = { minLeadMinutes: 15, maxLeadDays: 60, slotSpacingMinutes: 120 } as const;

export const POSTING_SLOTS: ReadonlyArray<{ hour: number; minute: number }> = [
  { hour: 12, minute: 0 },
  { hour: 19, minute: 0 },
  { hour: 21, minute: 0 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

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

export function suggestPostingSlots(input: { now: Date; taken: readonly Date[]; count: number }): Date[] {
  const slots: Date[] = [];
  const spacingMs = SCHEDULE_LIMITS.slotSpacingMinutes * MINUTE_MS;
  for (let dayOffset = 0; dayOffset <= SCHEDULE_LIMITS.maxLeadDays && slots.length < input.count; dayOffset += 1) {
    for (const slot of POSTING_SLOTS) {
      const candidate = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() + dayOffset, slot.hour, slot.minute, 0, 0);
      if (scheduledAtProblem(candidate, input.now) !== null) {
        continue;
      }
      if (input.taken.some((taken) => Math.abs(taken.getTime() - candidate.getTime()) < spacingMs)) {
        continue;
      }
      slots.push(candidate);
      if (slots.length === input.count) {
        break;
      }
    }
  }
  return slots;
}
