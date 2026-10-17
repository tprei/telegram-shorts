import { useEffect, useId, useRef, useState } from 'react';
import type { ExportDto, PlatformAvailabilityDto, PublicationDto } from '@api';
import type { PublicationStatus, ShortVideoPlatform } from '@domain/model';
import { Button, EmptyState, Icon } from './StudioPrimitives';

export interface PublishPanelProps {
  latestReadyExport: ExportDto | null;
  exports: readonly ExportDto[];
  publications: readonly PublicationDto[];
  platforms: readonly PlatformAvailabilityDto[];
  selectedPlatforms: readonly ShortVideoPlatform[];
  publishPending?: boolean;
  copyReady: boolean;
  onSelectedPlatformsChange: (platforms: ShortVideoPlatform[]) => void;
  onPublish: (force: boolean, platforms: ShortVideoPlatform[]) => void;
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
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
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
  }
}

function selectionReason(attempts: readonly PublicationDto[], latestExportId: string): string | null {
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

interface PublicationOutcomeProps {
  publication: PublicationDto;
  exportItem: ExportDto | undefined;
  historical?: boolean;
}

function PublicationOutcome({ publication, exportItem, historical = false }: PublicationOutcomeProps) {
  const timestamp = publication.status === 'submitted'
    ? publication.submittedAt ?? publication.updatedAt
    : publication.updatedAt;
  return (
    <div className={`publish-outcome publish-outcome--${publication.status}${historical ? ' publish-outcome--historical' : ''}`}>
      <div className="publish-outcome-line">
        <span className="publish-outcome-mark" aria-hidden="true">
          {publication.status === 'published' ? <Icon name="check" size={15} />
            : publication.status === 'failed' || publication.status === 'unconfirmed' ? <Icon name="alert" size={15} />
              : <span />}
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
  publishPending = false,
  copyReady,
  onSelectedPlatformsChange,
  onPublish,
}: PublishPanelProps) {
  const id = useId();
  const confirmationTitle = useRef<HTMLHeadingElement>(null);
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
    const reason = !availability?.available
      ? availability?.reason || 'No publishing provider connected.'
      : !latestReadyExport
        ? 'Export a video before selecting this platform.'
        : selectionReason(attempts, latestReadyExport.id);
    return { platform, attempts, reason, available: Boolean(availability?.available) };
  });
  const selected = groups
    .filter((group) => !group.reason && selectedPlatforms.includes(group.platform))
    .map((group) => group.platform);
  const repostable = groups
    .filter((group) => group.available
      && group.attempts.some((item) => POSTED_OR_UNKNOWN_STATUSES[item.status] === true)
      && !group.attempts.some((item) => IN_FLIGHT_STATUSES[item.status] === true))
    .map((group) => group.platform);
  const forceOpen = forceDraft !== null && forceDraft.exportId === latestReadyExport?.id;
  const forceTargets = forceOpen
    ? repostable.filter((platform) => forceDraft.platforms.includes(platform))
    : [];
  const canPublish = Boolean(latestReadyExport && copyReady && selected.length > 0 && !publishPending);
  const canRepost = Boolean(latestReadyExport && copyReady && repostable.length > 0 && !publishPending);
  const publishHelp = !latestReadyExport
    ? 'Export a video before publishing.'
    : !copyReady
      ? 'Add both lines of publish copy and at least one hashtag.'
      : selected.length === 0
        ? 'Choose an available destination to publish.'
        : `Publishes revision ${latestReadyExport.editRevision} to ${destinationList.format(selected.map((platform) => platformNames[platform]))}.`;

  useEffect(() => {
    if (!forceOpen) return;
    const heading = confirmationTitle.current;
    heading?.focus({ preventScroll: true });
    heading?.closest('.publish-force-confirmation')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [forceOpen]);

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
      <div className="publish-platforms">
        {groups.map(({ platform, attempts, reason }) => {
          const latest = attempts[0];
          const earlier = attempts.slice(1);
          const failedCount = earlier.filter((item) => item.status === 'failed').length;
          const disabled = Boolean(reason || publishPending);
          const describedBy = reason || publishPending ? `${id}-${platform}-reason` : undefined;
          return (
            <article className="publish-platform" key={platform} aria-labelledby={`${id}-${platform}-name`}>
              <label className={`publish-platform-choice${disabled ? ' is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={!reason && selected.includes(platform)}
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
                    />
                  ) : <p className="publish-no-attempt">No publishing attempts yet.</p>}
                </div>
                {(reason || publishPending) && (
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
      <div className="publish-actions">
        <p className="publish-action-help" id={`${id}-publish-help`}>{publishHelp}</p>
        <Button
          variant="primary"
          className="full-width"
          pending={publishPending}
          disabled={!canPublish}
          aria-describedby={`${id}-publish-help`}
          onClick={() => onPublish(false, selected)}
        >
          {publishPending ? 'Sending publish request…' : selected.length > 0
            ? `Publish to ${selected.length} ${selected.length === 1 ? 'platform' : 'platforms'}`
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
          <fieldset className="publish-force-targets" disabled={publishPending}>
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
                onPublish(true, forceTargets);
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
