import { zonedDateParts } from '@domain/schedule';

export const operatorTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function postingTimeZoneLabel(timeZone: string): string {
  if (timeZone === 'America/Sao_Paulo') return 'São Paulo';
  if (timeZone === 'Europe/London') return 'London';
  return (timeZone.split('/').at(-1) ?? timeZone).replaceAll('_', ' ');
}

export interface PostingDateFormatters {
  day: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
  button: Intl.DateTimeFormat;
}
const formatterCache = new Map<string, PostingDateFormatters>();
function createFormatters(timeZone: string): PostingDateFormatters {
  const locale = 'en-GB';
  return {
    day: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }),
    time: new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    dateTime: new Intl.DateTimeFormat(locale, {
      timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }),
    button: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}
export function postingDateFormatters(timeZone: string) {
  let formatters = formatterCache.get(timeZone);
  if (!formatters) {
    formatters = createFormatters(timeZone);
    formatterCache.set(timeZone, formatters);
  }
  return formatters;
}

export function zonedDateTimeValue(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export interface PostingTimeProps {
  dateTime: string;
  timeZone: string;
  className?: string;
}

export function PostingTime({ dateTime, timeZone, className = '' }: PostingTimeProps) {
  const date = new Date(dateTime);
  const primary = postingDateFormatters(timeZone);
  return (
    <time className={`posting-time ${className}`} dateTime={dateTime} title={`${primary.dateTime.format(date)} · ${timeZone}`}>
      <strong>{primary.time.format(date)}</strong>
      <span>{primary.day.format(date)} · {postingTimeZoneLabel(timeZone)}</span>
      {operatorTimeZone !== timeZone && (
        <small>{postingDateFormatters(operatorTimeZone).dateTime.format(date)} · {postingTimeZoneLabel(operatorTimeZone)}</small>
      )}
    </time>
  );
}
