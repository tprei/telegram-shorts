import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AutopilotStatusDto } from '@api';
import type { AutopilotShortState, ShortVideoPlatform } from '@domain/model';
import { zonedDateParts, zonedTimeToUtc } from '@domain/schedule';
import { ApiError, Button, Icon, relativeTime, Toggle } from './StudioPrimitives';
import { operatorTimeZone, PostingTime, postingDateFormatters, postingTimeZoneLabel } from './PostingTime';
import '../styles/autopilot.css';
import '../styles/scene-layout.css';

export interface AutopilotPanelProps {
  statuses: readonly AutopilotStatusDto[];
  onToggle: (creatorId: string, enabled: boolean) => void;
  onCheckNow: (creatorId: string) => void;
  pendingCreatorIds?: readonly string[];
  error?: string | null;
}

const shortStateLabels: Record<AutopilotShortState, string> = {
  waiting: 'Waiting',
  exporting: 'Exporting',
  ready: 'Ready to schedule',
  booked: 'Scheduled',
  skipped: 'Skipped',
  expired: 'Expired',
};
const platformLabels: Record<ShortVideoPlatform, string> = {
  instagram: 'Instagram', tiktok: 'TikTok', youtube_shorts: 'YouTube Shorts',
};

interface AutopilotCardProps {
  status: AutopilotStatusDto;
  pending: boolean;
  onToggle: AutopilotPanelProps['onToggle'];
  onCheckNow: AutopilotPanelProps['onCheckNow'];
}

function AutopilotCard({ status, pending, onToggle, onCheckNow }: AutopilotCardProps) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const switchRegion = useRef<HTMLDivElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const schedule = status.schedule;
  const connected = status.accountConnected;
  const enabled = status.enabled && connected;
  const connectionReason = status.reason ?? 'Account not connected in Mallary';
  const today = schedule ? zonedDateParts(new Date(), schedule.timeZone) : null;
  const zoneLabel = schedule ? postingTimeZoneLabel(schedule.timeZone) : null;
  const localZoneLabel = postingTimeZoneLabel(operatorTimeZone);
  useEffect(() => {
    if (confirming) confirmationHeading.current?.focus({ preventScroll: true });
  }, [confirming]);
  useEffect(() => {
    if (status.enabled || !connected) setConfirming(false);
  }, [status.enabled, connected]);
  function closeConfirmation() {
    setConfirming(false);
    switchRegion.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }
  return (
    <article className={`autopilot-card${enabled ? ' is-enabled' : ''}`} aria-labelledby={`${id}-title`}>
      <div className="autopilot-header">
        <div className="autopilot-identity">
          <span className="autopilot-mark"><Icon name="spark" size={21} /></span>
          <div>
            <h2 id={`${id}-title`}>Autopilot</h2>
            <a href={status.channelUrl} className="autopilot-creator" target="_blank" rel="noopener noreferrer">
              {status.displayName}<Icon name="external" size={12} />
              <span className="publish-sr-only"> YouTube channel (opens in a new tab)</span>
            </a>
          </div>
        </div>
        <div className="autopilot-switch" ref={switchRegion} aria-busy={pending || undefined}>
          {pending && <span className="spinner" aria-hidden="true" />}
          <Toggle
            label={enabled ? 'On' : 'Off'}
            description={connected ? `${status.displayName} autopilot` : `${status.displayName} autopilot. ${connectionReason}. Connect the publishing account to enable Autopilot.`}
            checked={enabled}
            disabled={pending || !connected}
            onChange={(enabled) => {
              if (enabled) setConfirming(true);
              else onToggle(status.creatorId, false);
            }}
          />
        </div>
      </div>
      {!connected && (
        <div className="autopilot-disconnected" role="note">
          <Icon name="alert" size={16} />
          <div><strong>{connectionReason}</strong><p>Connect the publishing account in Mallary to turn on Autopilot.</p></div>
        </div>
      )}
      {confirming && !enabled && connected && (
        <div className="autopilot-confirmation" role="group" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-copy`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeConfirmation();
            }
          }}>
          <h3 id={`${id}-confirm-title`} ref={confirmationHeading} tabIndex={-1}>Turn on Autopilot?</h3>
          <p id={`${id}-confirm-copy`}>
            Each new video from {status.displayName} is planned into shorts. Autopilot picks the best {status.shortsPerVideo}, exports them,
            and books them on {status.platforms.map((platform) => platformLabels[platform]).join(' and ')} at least {status.reviewWindowHours} h ahead.
            Review them in <a href="#upcoming-title">Upcoming posts</a> and cancel any you don’t want. Otherwise, they’ll post automatically.
          </p>
          <div className="button-group">
            <Button onClick={closeConfirmation} disabled={pending}>Not now</Button>
            <Button variant="primary" pending={pending} onClick={() => {
              setConfirming(false);
              onToggle(status.creatorId, true);
              switchRegion.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
            }}>Turn on Autopilot</Button>
          </div>
        </div>
      )}
      <div className="autopilot-plan">
        <div className="autopilot-plan-heading">
          <p><strong>{status.shortsPerVideo} shorts</strong> per new video</p>
          <span>{status.platforms.map((platform) => platformLabels[platform]).join(' + ')}</span>
        </div>
        {schedule && today && (
          <>
            <div className="autopilot-slots-heading">
              <span>Posting times · <strong>{zoneLabel}</strong></span>
              {operatorTimeZone !== schedule.timeZone && <span>{localZoneLabel} today below</span>}
            </div>
            <ul className="autopilot-slots" aria-label={`Posting times in ${zoneLabel}`}>
              {schedule.slots.map((slot) => {
                const [hour = 0, minute = 0] = slot.split(':').map(Number);
                const date = zonedTimeToUtc({ year: today.year, month: today.month, day: today.day, hour, minute, timeZone: schedule.timeZone });
                const nextDay = postingDateFormatters(operatorTimeZone).day.format(date) !== postingDateFormatters(schedule.timeZone).day.format(date);
                return (
                  <li key={slot}>
                    <strong>{slot}</strong>
                    {operatorTimeZone !== schedule.timeZone && <span>{postingDateFormatters(operatorTimeZone).time.format(date)} {localZoneLabel}{nextDay ? ' (+1 day)' : ''}</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="autopilot-review"><Icon name="clock" size={14} />At least {status.reviewWindowHours} h to review in <a href="#upcoming-title">Upcoming posts</a>.</p>
      </div>
      <div className={`autopilot-check${status.lastCheckError && !status.checkRequested ? ' has-error' : ''}`}>
        <div className="autopilot-check-status" role="status" aria-live="polite">
          {status.checkRequested ? <><span className="spinner" aria-hidden="true" /><div><strong>Checking the channel…</strong><p>New videos will appear below.</p></div></>
            : status.lastCheckError ? <><Icon name="alert" size={17} /><div><strong>Couldn’t check the channel</strong><p>{status.lastCheckError}</p></div></>
              : <><span className={`autopilot-check-dot${enabled ? ' is-watching' : ''}`} /><div>
                <strong>{enabled ? 'Watching for new videos' : 'Autopilot is off'}</strong>
                <p>{status.lastCheckedAt ? <>Last checked <time dateTime={status.lastCheckedAt} title={postingDateFormatters(operatorTimeZone).dateTime.format(new Date(status.lastCheckedAt))}>{relativeTime(status.lastCheckedAt)}</time></> : 'No checks yet'}</p>
              </div></>}
        </div>
        <Button icon="undo" pending={status.checkRequested} disabled={pending} onClick={() => onCheckNow(status.creatorId)}>
          {status.checkRequested ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      {status.videos.length === 0 ? (
        <div className="autopilot-empty"><Icon name="video" size={21} /><p>{connected ? 'Watching the channel. New videos show up here' : 'No videos tracked yet.'}</p></div>
      ) : (
        <div className="autopilot-videos">
          <p className="eyebrow">LATEST VIDEOS</p>
          {status.videos.map((video) => (
            <section className="autopilot-video" key={video.videoId} aria-labelledby={`${id}-${video.videoId}`}>
              <div className="autopilot-video-heading">
                <h3 id={`${id}-${video.videoId}`}>{video.jobId ? <Link to={`/jobs/${video.jobId}`}>{video.title || 'New channel video'}</Link> : video.title || 'New channel video'}</h3>
                <time dateTime={video.detectedAt}>{relativeTime(video.detectedAt)}</time>
              </div>
              {video.shorts.length === 0 ? (
                <p className="autopilot-video-pending">{video.jobStatus === 'failed' ? 'This video needs attention. Open it to see what happened.' : 'Finding the strongest moments…'}</p>
              ) : (
                <ul className="autopilot-shorts">
                  {video.shorts.map((short) => (
                    <li className={`autopilot-short autopilot-short--${short.state}`} key={short.shortId}>
                      <div className="autopilot-short-main">
                        <Link to={`/shorts/${short.shortId}`} className="autopilot-short-link"><span>{short.title}</span><Icon name="arrow" size={14} /></Link>
                        {short.reason && <p className="autopilot-short-reason">{short.reason}</p>}
                        {short.state === 'booked' && short.scheduledFor && <PostingTime dateTime={short.scheduledFor} timeZone={schedule?.timeZone ?? operatorTimeZone} className="autopilot-booked" />}
                        {short.state === 'booked' && <p className="autopilot-short-reason">Edits after booking aren't posted. To change it, cancel the post and schedule the new export from the editor.</p>}
                      </div>
                      <span className={`autopilot-short-state autopilot-short-state--${short.state}`}>
                        {short.state === 'exporting' && <span className="spinner" aria-hidden="true" />}
                        {short.state === 'booked' && <Icon name="check" size={12} />}
                        {shortStateLabels[short.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

export function AutopilotPanel({ statuses, onToggle, onCheckNow, pendingCreatorIds = [], error }: AutopilotPanelProps) {
  if (statuses.length === 0 && !error) return null;
  return (
    <section className="autopilot-panel" aria-label="Channel autopilot">
      <ApiError message={error} title="Couldn’t update Autopilot" />
      {statuses.map((status) => <AutopilotCard key={status.creatorId} status={status} pending={pendingCreatorIds.includes(status.creatorId)} onToggle={onToggle} onCheckNow={onCheckNow} />)}
    </section>
  );
}
