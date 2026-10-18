import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ExportDto, PlatformAvailabilityDto, PublicationDto, ScheduledPostDto } from '@api';
import type { PublicationStatus, ShortVideoPlatform } from '@domain/model';
import { scheduledAtProblem, SCHEDULE_LIMITS, suggestPostingSlots } from '@domain/schedule';
import {
  ApiError, Button, EmptyState, Icon, ScheduleCancelButton, localDateTimeValue,
  scheduleButtonTime, scheduleDateTime, scheduleDay, scheduleTime,
} from './StudioPrimitives';

export interface PublishPanelProps {
  latestReadyExport: ExportDto | null;
  exports: readonly ExportDto[];
  publications: readonly PublicationDto[];
  platforms: readonly PlatformAvailabilityDto[];
  selectedPlatforms: readonly ShortVideoPlatform[];
  upcomingPosts: readonly ScheduledPostDto[];
  cancellingPublicationIds?: readonly string[];
  cancelError?: string | null;
  onCancelPublication: (publicationId: string) => void;
  publishPending?: boolean;
  copyReady: boolean;
  onSelectedPlatformsChange: (platforms: ShortVideoPlatform[]) => void;
  onPublish: (force: boolean, platforms: ShortVideoPlatform[], scheduledAt: string | null) => void;
}

const platformNames: Record<ShortVideoPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
};

const providerNames: Record<string, string> = { mallary: 'Mallary', buffer: 'Buffer' };

const IN_FLIGHT_STATUSES: Partial<Record<PublicationStatus, true>> = {
  queued: true,
  publishing: true,
  submitted: true,
  deferred: true,
};
const POSTED_OR_UNKNOWN_STATUSES: Partial<Record<PublicationStatus, true>> = {
  published: true,
  unconfirmed: true,
};

const attemptDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const destinationList = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' });

function firstErrorLine(error: string | null): string {
  if (!error?.trim()) return 'The post could not be published.';
  const firstLine = error.split(/\r?\n/).find((line) => line.trim()) ?? error;
  const firstProvider = firstLine.split(/\s*\|\s*/)[0] ?? firstLine;
  return firstProvider
    .replace(/^All short-video publish providers failed for [^:]+:\s*/i, '')
    .replace(/^(?:mallary|buffer):\s*/i, '')
    .replace(/^(?:\w*Error:\s*)+/i, '')
    .replace(/^(?:Mallary create post|Buffer (?:create post|publish|mutation)) failed:\s*/i, '')
    .replace(/^(?:HTTP\s*)?\d{3}(?:\s*[-:]\s*|\s+)/i, '')
    .trim() || 'The post could not be published.';
}

function statusLabel(publication: PublicationDto): string {
  const platform = platformNames[publication.platform];
  switch (publication.status) {
    case 'queued':
      return 'Queued';
    case 'publishing':
      return 'Uploading and sending';
    case 'submitted':
      return `Sent to ${publication.provider ? providerNames[publication.provider.toLowerCase()] ?? publication.provider : 'the provider'}, waiting for ${platform}`;
    case 'published':
      return `Live on ${platform}`;
    case 'unconfirmed':
      return `Couldn't confirm. Check ${platform} before reposting.`;
    case 'deferred':
      return `Waiting for the posting limit, retries ${publication.availableAt ? attemptDate.format(new Date(publication.availableAt)) : 'when the limit resets'}`;
    case 'failed':
      return firstErrorLine(publication.error);
    case 'scheduled':
      return publication.scheduledFor
        ? `Scheduled for ${scheduleDateTime.format(new Date(publication.scheduledFor))}`
        : 'Scheduled';
    case 'cancelled':
      return 'Schedule cancelled';
  }
}

function selectionReason(attempts: readonly PublicationDto[], latestExportId: string): string | null {
  const scheduled = attempts.find((item) => item.status === 'scheduled');
  if (scheduled) return 'A post is already scheduled. Cancel it before scheduling again.';
  const inFlightHere = attempts.find((item) => item.exportId === latestExportId && IN_FLIGHT_STATUSES[item.status] === true);
  if (inFlightHere) {
    switch (inFlightHere.status) {
      case 'queued':
        return 'Already queued for this export.';
      case 'publishing':
        return 'This export is already uploading and sending.';
      case 'submitted':
        return 'Already sent. Waiting for the platform to confirm.';
      case 'deferred':
        return 'Already scheduled to retry after the posting limit resets.';
    }
  }
  const inFlightElsewhere = attempts.find((item) => item.exportId !== latestExportId && IN_FLIGHT_STATUSES[item.status] === true);
  if (inFlightElsewhere) {
    return 'An attempt on an earlier export is still in flight; wait for it to settle before publishing.';
  }
  const posted = attempts.find((item) => POSTED_OR_UNKNOWN_STATUSES[item.status] === true);
  if (posted) {
    return posted.status === 'published'
      ? 'Already live for this short. Use Force repost to post it again.'
      : 'The last attempt could not be confirmed. Check the platform, then use Force repost if it went live.';
  }
  return null;
}

interface PublishBatch {
  platforms: ShortVideoPlatform[];
  exportId: string;
  scheduledAt: string | null;
  previousIds: string[];
  selectionKey: string;
  request: 'starting' | 'pending' | 'finished';
}

interface PublicationOutcomeProps {
  publication: PublicationDto;
  exportItem: ExportDto | undefined;
  historical?: boolean;
  cancellingPublicationIds: readonly string[];
  onCancelPublication: (publicationId: string) => void;
}

function PublicationOutcome({
  publication, exportItem, historical = false, cancellingPublicationIds, onCancelPublication,
}: PublicationOutcomeProps) {
  const timestamp = publication.status === 'submitted'
    ? publication.submittedAt ?? publication.updatedAt
    : publication.updatedAt;
  return (
    <div className={`publish-outcome publish-outcome--${publication.status}${historical ? ' publish-outcome--historical' : ''}`}>
      <div className="publish-outcome-line">
        <span className="publish-outcome-mark" aria-hidden="true">
          {publication.status === 'published' ? <Icon name="check" size={15} />
            : publication.status === 'scheduled' ? <Icon name="clock" size={15} />
              : publication.status === 'cancelled' ? <Icon name="close" size={15} />
                : publication.status === 'failed' || publication.status === 'unconfirmed' ? <Icon name="alert" size={15} />
                  : <span className="spinner" />}
        </span>
        <p>{statusLabel(publication)}</p>
      </div>
      {publication.status === 'published' && publication.url && (
        <a className="publish-post-link" href={publication.url} target="_blank" rel="noopener noreferrer">
          View post on {platformNames[publication.platform]} <Icon name="external" size={13} />
        </a>
      )}
      <div className="publish-attempt-meta">
        <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>{attemptDate.format(new Date(timestamp))}</time>
        <span>{exportItem ? `Revision ${exportItem.editRevision}` : 'Earlier export'}</span>
        {publication.forced && <span>Force repost</span>}
      </div>
      {publication.scheduledFor && ['scheduled', 'queued', 'deferred'].includes(publication.status) && (
        <ScheduleCancelButton
          description={`${platformNames[publication.platform]} post for ${scheduleDateTime.format(new Date(publication.scheduledFor))}`}
          pending={cancellingPublicationIds.includes(publication.id)}
          onConfirm={() => onCancelPublication(publication.id)}
        />
      )}
      {(publication.status === 'failed' || publication.status === 'unconfirmed') && publication.error && (
        <details className="publish-error-details">
          <summary>Details<span className="publish-sr-only"> of the {publication.status === 'unconfirmed' ? 'unconfirmed' : 'failed'} {platformNames[publication.platform]} attempt</span></summary>
          <p>{publication.error}</p>
        </details>
      )}
    </div>
  );
}

export function PublishPanel({
  latestReadyExport,
  exports,
  publications,
  platforms,
  selectedPlatforms,
  upcomingPosts,
  cancellingPublicationIds = [],
  cancelError,
  onCancelPublication,
  publishPending = false,
  copyReady,
  onSelectedPlatformsChange,
  onPublish,
}: PublishPanelProps) {
  const id = useId();
  const confirmationTitle = useRef<HTMLHeadingElement>(null);
  const feedbackRegion = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const selectionKey = [...selectedPlatforms].sort().join(',');
  const [when, setWhen] = useState<'now' | 'schedule'>('now');
  const [scheduleNow, setScheduleNow] = useState(() => new Date());
  const [customTime, setCustomTime] = useState('');
  const [timeChoice, setTimeChoice] = useState<string | null>(null);
  const [customTouched, setCustomTouched] = useState(false);
  const suggestedSlots = useMemo(() => suggestPostingSlots({
    now: scheduleNow,
    taken: upcomingPosts.map((post) => new Date(post.scheduledFor)),
    count: 4,
  }), [upcomingPosts, scheduleNow]);
  const chosenTime = timeChoice === 'custom' ? customTime : timeChoice ?? (
    suggestedSlots[0] ? localDateTimeValue(suggestedSlots[0]) : ''
  );
  const scheduledDate = chosenTime ? new Date(chosenTime) : null;
  const timeProblem = !scheduledDate || !Number.isFinite(scheduledDate.getTime())
    ? 'Choose a date and time.'
    : scheduledAtProblem(scheduledDate, new Date());
  const showTimeProblem = when === 'schedule' && timeProblem && (customTouched || timeChoice !== 'custom');
  const [batch, setBatch] = useState<PublishBatch | null>(() => {
    const active = publications.filter((item, index) => (IN_FLIGHT_STATUSES[item.status]
      || item.status === 'scheduled' || (item.status === 'cancelled' && item.scheduledFor))
      && publications.findIndex((other) => other.platform === item.platform) === index);
    const exportId = active[0]?.exportId;
    if (!exportId) return null;
    const targets = active.filter((item) => item.exportId === exportId);
    return {
      platforms: targets.map((item) => item.platform),
      exportId,
      scheduledAt: targets.find((item) => item.scheduledFor)?.scheduledFor ?? null,
      previousIds: publications.filter((item) => !targets.includes(item)).map((item) => item.id),
      selectionKey,
      request: publishPending ? 'pending' : 'finished',
    };
  });
  const batchAttempts = batch?.platforms.map((platform) => ({
    platform,
    publication: publications.find((item) => item.platform === platform
      && item.exportId === batch.exportId
      && !batch.previousIds.includes(item.id)),
  })) ?? [];
  const batchInFlight = Boolean(batch && (batch.request !== 'finished'
    || batchAttempts.some(({ publication }) => publication && IN_FLIGHT_STATUSES[publication.status])));
  const showBatch = batch && (batchInFlight || batch.selectionKey === selectionKey);
  const ongoingAttempts = publications.filter((item, index) => IN_FLIGHT_STATUSES[item.status]
    && publications.findIndex((other) => other.platform === item.platform) === index);
  const feedbackAttempts = showBatch ? batchAttempts
    : ongoingAttempts.map((publication) => ({ platform: publication.platform, publication }));
  const feedbackTargets = feedbackAttempts.length > 0
    ? feedbackAttempts.map(({ platform }) => platform)
    : publishPending ? [...selectedPlatforms] : [];
  const feedbackPending = publishPending || batchInFlight || ongoingAttempts.length > 0;
  const liveTargets = feedbackAttempts.filter(({ publication }) => publication?.status === 'published')
    .map(({ platform }) => platform);
  const failedTargets = feedbackAttempts.filter(({ publication }) => publication?.status === 'failed'
    || (!publication && batch?.request === 'finished')).map(({ platform }) => platform);
  const unconfirmedTargets = feedbackAttempts.filter(({ publication }) => publication?.status === 'unconfirmed')
    .map(({ platform }) => platform);
  const cancelledTargets = feedbackAttempts.filter(({ publication }) => publication?.status === 'cancelled')
    .map(({ platform }) => platform);
  const scheduledGroups = new Map<string, ShortVideoPlatform[]>();
  for (const { platform, publication } of feedbackAttempts) {
    if (publication?.status !== 'scheduled' || !publication.scheduledFor) continue;
    const targets = scheduledGroups.get(publication.scheduledFor) ?? [];
    targets.push(platform);
    scheduledGroups.set(publication.scheduledFor, targets);
  }
  const feedbackScheduling = Boolean(batch?.scheduledAt || feedbackAttempts.some(({ publication }) => publication?.scheduledFor));
  const feedbackWarning = failedTargets.length > 0 || unconfirmedTargets.length > 0 || cancelledTargets.length > 0;
  const formatPlatforms = (targets: readonly ShortVideoPlatform[]) =>
    destinationList.format(targets.map((platform) => platformNames[platform]));
  const feedbackTitle = feedbackPending
    ? `${feedbackScheduling || (publishPending && when === 'schedule') ? 'Scheduling on' : 'Publishing to'} ${formatPlatforms(feedbackTargets)}…`
    : [
      ...[...scheduledGroups].map(([date, targets]) =>
        `Scheduled on ${formatPlatforms(targets)} for ${scheduleDateTime.format(new Date(date))}`),
      liveTargets.length > 0 ? `Live on ${formatPlatforms(liveTargets)}` : '',
      cancelledTargets.length > 0 ? `Schedule cancelled on ${formatPlatforms(cancelledTargets)}` : '',
      failedTargets.length > 0 ? `Failed on ${formatPlatforms(failedTargets)}` : '',
      unconfirmedTargets.length > 0 ? `Not confirmed on ${formatPlatforms(unconfirmedTargets)}` : '',
    ].filter(Boolean).join(' · ');
  const [forceDraft, setForceDraft] = useState<{
    exportId: string;
    platforms: ShortVideoPlatform[];
  } | null>(null);
  const destinations = [...new Set([
    ...platforms.map((platform) => platform.platform),
    ...publications.map((publication) => publication.platform),
  ])];
  const groups = destinations.map((platform) => {
    const availability = platforms.find((item) => item.platform === platform);
    const attempts = publications.filter((item) => item.platform === platform);
    const reason = feedbackPending && feedbackTargets.includes(platform)
      ? 'Publishing is in progress. This destination cannot be posted to again yet.'
      : !availability?.available
        ? availability?.reason || 'No publishing provider connected.'
        : when === 'schedule' && !availability.canSchedule
          ? availability.reason || `${platformNames[platform]} scheduling isn’t available with the connected provider.`
          : !latestReadyExport
            ? 'Export a video before selecting this platform.'
            : selectionReason(attempts, latestReadyExport.id);
    return { platform, attempts, reason, available: Boolean(availability?.available && (when === 'now' || availability.canSchedule)) };
  });
  const selected = groups
    .filter((group) => !group.reason && selectedPlatforms.includes(group.platform))
    .map((group) => group.platform);
  const repostable = groups
    .filter((group) => group.available
      && group.attempts.some((item) => POSTED_OR_UNKNOWN_STATUSES[item.status] === true)
      && !group.attempts.some((item) => IN_FLIGHT_STATUSES[item.status] === true || item.status === 'scheduled'))
    .map((group) => group.platform);
  const forceOpen = forceDraft !== null && forceDraft.exportId === latestReadyExport?.id;
  const forceTargets = forceOpen
    ? repostable.filter((platform) => forceDraft.platforms.includes(platform))
    : [];
  const validTime = when === 'now' || !timeProblem;
  const canPublish = Boolean(latestReadyExport && copyReady && selected.length > 0 && !feedbackPending && validTime);
  const canRepost = Boolean(latestReadyExport && copyReady && repostable.length > 0 && !feedbackPending && validTime);
  const publishHelp = !latestReadyExport
    ? 'Export a video before publishing.'
    : !copyReady
      ? 'Add both lines of publish copy and at least one hashtag.'
      : selected.length === 0
        ? 'Choose an available destination to publish.'
        : when === 'schedule'
          ? `Schedules revision ${latestReadyExport.editRevision} on ${destinationList.format(selected.map((platform) => platformNames[platform]))}.`
          : `Publishes revision ${latestReadyExport.editRevision} to ${destinationList.format(selected.map((platform) => platformNames[platform]))}.`;
  const draftAccepted = Boolean(batch?.scheduledAt && scheduledDate && !timeProblem
    && batch.scheduledAt === scheduledDate.toISOString()
    && batchAttempts.length > 0
    && batchAttempts.every(({ publication }) => publication?.status === 'scheduled'
      || publication?.status === 'published' || publication?.status === 'cancelled'));

  useEffect(() => {
    if (!forceOpen) return;
    const heading = confirmationTitle.current;
    heading?.focus({ preventScroll: true });
    heading?.closest('.publish-force-confirmation')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [forceOpen]);

  useEffect(() => {
    setBatch((current) => {
      if (!current || current.request === 'finished') return current;
      if (publishPending && current.request === 'starting') return { ...current, request: 'pending' };
      if (!publishPending && current.request === 'pending') return { ...current, request: 'finished' };
      return current;
    });
  }, [publishPending]);

  useEffect(() => {
    if (!feedbackPending) actionLock.current = false;
  }, [feedbackPending]);

  useEffect(() => {
    if (batch) feedbackRegion.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [batch]);

  useEffect(() => {
    if (batch && !batchInFlight && batch.selectionKey !== selectionKey) setBatch(null);
  }, [batch, batchInFlight, selectionKey]);

  useEffect(() => {
    if (when !== 'schedule' || timeChoice !== 'custom' || !customTime || feedbackPending || draftAccepted) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when, timeChoice, customTime, feedbackPending, draftAccepted]);

  function startPublish(force: boolean, targets: ShortVideoPlatform[]) {
    if (!latestReadyExport || targets.length === 0 || feedbackPending || actionLock.current) return;
    if (when === 'schedule' && (!scheduledDate || timeProblem || scheduledAtProblem(scheduledDate, new Date()))) {
      setCustomTouched(true);
      setScheduleNow(new Date());
      return;
    }
    const scheduledAt = when === 'schedule' && scheduledDate ? scheduledDate.toISOString() : null;
    actionLock.current = true;
    setBatch({
      platforms: [...targets],
      exportId: latestReadyExport.id,
      scheduledAt,
      previousIds: publications.map((item) => item.id),
      selectionKey,
      request: 'starting',
    });
    onPublish(force, targets, scheduledAt);
  }

  function closeConfirmation() {
    setForceDraft(null);
    document.getElementById(`${id}-force-button`)?.focus();
  }

  return (
    <section className="inspector-section publish-panel" aria-labelledby={`${id}-title`}>
      <p className="eyebrow">DESTINATIONS</p>
      <div className="publish-panel-heading">
        <h3 id={`${id}-title`}>Publish destinations</h3>
        {latestReadyExport && <span>Ready export · r{latestReadyExport.editRevision}</span>}
      </div>
      <p className="publish-panel-intro">The latest attempt is shown first. Sent doesn’t mean live.</p>
      <fieldset className="publish-when" disabled={feedbackPending}>
        <legend>When</legend>
        <div className="publish-when-options">
          {(['now', 'schedule'] as const).map((value) => (
            <label key={value} className={when === value ? 'is-selected' : ''}>
              <input
                type="radio"
                name={`${id}-when`}
                value={value}
                checked={when === value}
                onChange={() => {
                  setWhen(value);
                  setScheduleNow(new Date());
                  setForceDraft(null);
                }}
              />
              <Icon name={value === 'now' ? 'play' : 'clock'} size={15} />
              {value === 'now' ? 'Post now' : 'Schedule'}
            </label>
          ))}
        </div>
        {when === 'schedule' && (
          <div className="publish-schedule">
            <p className="publish-schedule-label">Suggested times</p>
            <div className="publish-slot-options" role="group" aria-label="Suggested posting times">
              {suggestedSlots.map((slot) => {
                const value = localDateTimeValue(slot);
                return (
                  <button
                    key={value}
                    type="button"
                    className={`publish-slot${chosenTime === value && timeChoice !== 'custom' ? ' is-selected' : ''}`}
                    aria-pressed={chosenTime === value && timeChoice !== 'custom'}
                    onClick={() => {
                      setTimeChoice(value);
                      setCustomTouched(false);
                    }}
                  >
                    <span>{scheduleDay.format(slot)}</span>
                    <strong>{scheduleTime.format(slot)}</strong>
                  </button>
                );
              })}
            </div>
            <label className="publish-custom-time" htmlFor={`${id}-custom-time`}>Or choose a date and time</label>
            <input
              id={`${id}-custom-time`}
              type="datetime-local"
              step={60}
              value={customTime}
              min={localDateTimeValue(new Date(scheduleNow.getTime() + SCHEDULE_LIMITS.minLeadMinutes * 60_000))}
              max={localDateTimeValue(new Date(scheduleNow.getTime() + SCHEDULE_LIMITS.maxLeadDays * 86_400_000))}
              aria-invalid={Boolean(showTimeProblem)}
              aria-describedby={`${id}-timezone${showTimeProblem ? ` ${id}-time-error` : ''}`}
              onChange={(event) => {
                setCustomTime(event.target.value);
                setTimeChoice('custom');
                setCustomTouched(true);
                setScheduleNow(new Date());
              }}
              onBlur={() => {
                if (timeChoice === 'custom') setCustomTouched(true);
              }}
            />
            {showTimeProblem && <p className="publish-time-error" id={`${id}-time-error`} role="alert">{timeProblem}</p>}
            <p className="publish-timezone" id={`${id}-timezone`}>
              Times in {Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}.
              {' '}Mallary publishes even with your computer off.
            </p>
          </div>
        )}
      </fieldset>
      <div className="publish-platforms">
        {groups.map(({ platform, attempts, reason }) => {
          const latest = attempts[0];
          const earlier = attempts.slice(1);
          const failedCount = earlier.filter((item) => item.status === 'failed').length;
          const disabled = Boolean(reason || publishPending);
          const isTargetPending = feedbackPending && feedbackTargets.includes(platform);
          const describedBy = isTargetPending ? `${id}-publish-feedback`
            : reason || publishPending ? `${id}-${platform}-reason` : undefined;
          return (
            <article className="publish-platform" key={platform} aria-labelledby={`${id}-${platform}-name`}>
              <label className={`publish-platform-choice${disabled ? ' is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(platform) || isTargetPending}
                  disabled={disabled}
                  aria-describedby={describedBy}
                  onChange={(event) => onSelectedPlatformsChange(
                    event.target.checked ? [...selected, platform] : selected.filter((item) => item !== platform),
                  )}
                />
                <strong id={`${id}-${platform}-name`}>{platformNames[platform]}</strong>
              </label>
              <div className="publish-platform-body">
                <div className="publish-current-outcome" aria-live="polite" aria-atomic="true">
                  {latest ? (
                    <PublicationOutcome
                      key={latest.id}
                      publication={latest}
                      exportItem={exports.find((item) => item.id === latest.exportId)}
                      cancellingPublicationIds={cancellingPublicationIds}
                      onCancelPublication={onCancelPublication}
                    />
                  ) : <p className="publish-no-attempt">No publishing attempts yet.</p>}
                </div>
                {!isTargetPending && (reason || publishPending) && (
                  <p className="publish-selection-reason" id={describedBy}>
                    {reason || 'A publishing request is in progress.'}
                  </p>
                )}
                {earlier.length > 0 && (
                  <details className="publish-history">
                    <summary>
                      {earlier.length} earlier {earlier.length === 1 ? 'attempt' : 'attempts'}
                      {failedCount > 0 && <span> · {failedCount} failed</span>}
                    </summary>
                    <div className="publish-history-list">
                      {earlier.map((publication) => (
                        <PublicationOutcome
                          key={publication.id}
                          publication={publication}
                          exportItem={exports.find((item) => item.id === publication.exportId)}
                          cancellingPublicationIds={cancellingPublicationIds}
                          onCancelPublication={onCancelPublication}
                          historical
                        />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {groups.length === 0 && (
        <EmptyState title="No destinations connected">
          Connect a publishing provider to see available platforms.
        </EmptyState>
      )}
      <ApiError message={cancelError} title="Couldn’t cancel the scheduled post" />
      <div className="publish-actions" ref={feedbackRegion}>
        <div className="publish-feedback" id={`${id}-publish-feedback`} aria-live="polite" aria-atomic="true">
          {feedbackTargets.length > 0 && (
            <div className={`publish-feedback-card${feedbackPending ? ' is-pending' : feedbackWarning ? ' has-warning' : ' is-live'}`}>
              <div className="publish-feedback-heading">
                {feedbackPending ? <span className="spinner" aria-hidden="true" />
                  : <Icon name={feedbackWarning ? 'alert' : scheduledGroups.size > 0 ? 'clock' : 'check'} size={17} />}
                <strong>{feedbackTitle}</strong>
              </div>
              <ul className="publish-feedback-platforms">
                {feedbackTargets.map((platform) => {
                  const publication = feedbackAttempts.find((item) => item.platform === platform)?.publication;
                  const pending = !publication && feedbackPending;
                  return (
                    <li key={platform}>
                      <span className="publish-feedback-platform-name">{platformNames[platform]}</span>
                      <span className={`publish-feedback-platform-state${publication ? ` publish-outcome--${publication.status}` : ''}`}>
                        {(pending || (publication && IN_FLIGHT_STATUSES[publication.status])) && <span className="spinner" aria-hidden="true" />}
                        {publication?.status === 'published' && publication.url ? (
                          <a href={publication.url} target="_blank" rel="noopener noreferrer">
                            Live · View post <Icon name="external" size={12} />
                          </a>
                        ) : publication ? statusLabel(publication) : pending
                          ? 'Starting publish request…'
                          : 'Request did not complete. Check the error below before trying again.'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {feedbackPending && <p>Uploads can take a few minutes. It’s safe to leave this page — {feedbackScheduling ? 'scheduling' : 'publishing'} continues on the server.</p>}
              {!feedbackPending && scheduledGroups.size > 0 && <p>Mallary will publish at the scheduled time, even with your computer off.</p>}
              {!feedbackPending && unconfirmedTargets.length > 0 && <p>Check the platform before reposting to avoid duplicates.</p>}
            </div>
          )}
        </div>
        {!feedbackPending && (feedbackTargets.length === 0 || selected.length > 0) && <p className="publish-action-help" id={`${id}-publish-help`}>{publishHelp}</p>}
        <Button
          variant="primary"
          className="full-width"
          pending={feedbackPending}
          disabled={!canPublish}
          aria-describedby={showTimeProblem ? `${id}-time-error` : feedbackTargets.length > 0 ? `${id}-publish-feedback` : `${id}-publish-help`}
          onClick={() => startPublish(false, selected)}
        >
          {feedbackPending ? (feedbackScheduling || when === 'schedule' ? 'Scheduling in progress…' : 'Publishing in progress…')
            : when === 'schedule' ? (scheduledDate && !timeProblem ? `Schedule for ${scheduleButtonTime(scheduledDate)}` : 'Schedule selected platforms')
              : selected.length > 0 ? `Publish to ${selected.length} ${selected.length === 1 ? 'platform' : 'platforms'}`
                : 'Publish selected platforms'}
        </Button>
        <Button
          id={`${id}-force-button`}
          variant="ghost"
          className="publish-force-button full-width"
          disabled={!canRepost}
          aria-expanded={forceOpen}
          aria-controls={`${id}-force-confirmation`}
          aria-describedby={`${id}-force-help`}
          onClick={() => setForceDraft({ exportId: latestReadyExport!.id, platforms: repostable })}
        >
          Force repost
        </Button>
        <p className="publish-force-help" id={`${id}-force-help`}>
          Force repost needs a live or unconfirmed post and no attempt in flight.
        </p>
      </div>
      {forceOpen && (
        <div
          className="publish-force-confirmation"
          id={`${id}-force-confirmation`}
          role="group"
          aria-labelledby={`${id}-force-title`}
          aria-describedby={`${id}-force-description`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeConfirmation();
            }
          }}
        >
          <div className="publish-force-heading">
            <Icon name="alert" size={19} />
            <h4 id={`${id}-force-title`} tabIndex={-1} ref={confirmationTitle}>
              {forceTargets.length > 0
                ? `Repost to ${destinationList.format(forceTargets.map((platform) => platformNames[platform]))}?`
                : 'Choose platforms to repost'}
            </h4>
          </div>
          <p id={`${id}-force-description`}>
            This creates new posts. The existing posts stay up, so your audience may see duplicates.
          </p>
          <fieldset className="publish-force-targets" disabled={feedbackPending}>
            <legend>Platforms with a live or unconfirmed post</legend>
            {repostable.map((platform) => (
              <label key={platform}>
                <input
                  type="checkbox"
                  checked={forceTargets.includes(platform)}
                  onChange={(event) => setForceDraft({
                    exportId: latestReadyExport!.id,
                    platforms: event.target.checked
                      ? [...forceTargets, platform]
                      : forceTargets.filter((item) => item !== platform),
                  })}
                />
                {platformNames[platform]}
              </label>
            ))}
          </fieldset>
          <div className="button-group">
            <Button variant="secondary" onClick={closeConfirmation}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!canRepost || forceTargets.length === 0}
              pending={publishPending}
              onClick={() => {
                startPublish(true, forceTargets);
                setForceDraft(null);
              }}
            >
              Confirm repost{forceTargets.length > 0 ? ` to ${forceTargets.length}` : ''}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
