import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AutopilotStatusDto, CreatorDto, CreateJobRequest, JobSummaryDto, ScheduledPostDto } from '@api';
import {
  ApiError,
  Button,
  EmptyState,
  Icon,
  ScheduleCancelButton,
  StatusBadge,
  StudioShell,
  relativeTime,
} from '../components/StudioPrimitives';
import { AutopilotPanel } from '../components/AutopilotPanel';
import { PostingTime, postingDateFormatters, postingTimeZoneLabel } from '../components/PostingTime';
import '../styles/studio.css';

export interface InboxViewProps {
  creators: CreatorDto[];
  jobs: JobSummaryDto[];
  upcomingPosts: readonly ScheduledPostDto[];
  autopilotStatuses: readonly AutopilotStatusDto[];
  onToggleAutopilot: (creatorId: string, enabled: boolean) => void;
  onCheckAutopilotNow: (creatorId: string) => void;
  pendingAutopilotCreatorIds?: readonly string[];
  autopilotError?: string | null;
  onCancelPublication: (publicationId: string, shortId: string) => void;
  scheduleLoading?: boolean;
  scheduleError?: string | null;
  cancellingPublicationIds?: readonly string[];
  cancelError?: string | null;
  loading?: boolean;
  pending?: boolean;
  error?: string | null;
  onAddVideo: (request: CreateJobRequest) => void;
}
export function InboxView({
  creators,
  jobs,
  upcomingPosts,
  autopilotStatuses,
  onToggleAutopilot,
  onCheckAutopilotNow,
  pendingAutopilotCreatorIds,
  autopilotError,
  onCancelPublication,
  scheduleLoading = false,
  scheduleError,
  cancellingPublicationIds = [],
  cancelError,
  loading = false,
  pending = false,
  error,
  onAddVideo,
}: InboxViewProps) {
  const [url, setUrl] = useState('');
  const [creatorId, setCreatorId] = useState<string | null>(null);
  const selectedCreator =
    creatorId ?? creators.find((creator) => creator.isDefault)?.id ?? creators[0]?.id ?? '';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (url.trim() && selectedCreator) onAddVideo({ url: url.trim(), creatorId: selectedCreator });
  }
  return (
    <StudioShell>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>From long-form to the good part.</h1>
          <p className="muted">Bring a video. Find the moments worth sharing.</p>
        </div>
        <span className="workspace-count">
          {jobs.length} source {jobs.length === 1 ? 'video' : 'videos'}
        </span>
      </div>
      <section className="ingest-card" aria-labelledby="add-video-title">
        <div className="ingest-intro">
          <span className="accent-icon">
            <Icon name="plus" size={22} />
          </span>
          <div>
            <h2 id="add-video-title">Add a source video</h2>
            <p>We’ll transcribe it and find up to five strong shorts.</p>
          </div>
        </div>
        <form className="ingest-form" onSubmit={submit}>
          <label className="url-field">
            <span>YouTube URL</span>
            <input
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          <label className="creator-field">
            <span>Creator</span>
            <select
              value={selectedCreator}
              onChange={(event) => setCreatorId(event.target.value)}
              disabled={pending || creators.length === 0}
              required
            >
              {creators.length === 0 && <option value="">No creators available</option>}
              {creators.map((creator) => (
                <option key={creator.id} value={creator.id}>
                  {creator.displayName}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            icon="arrow"
            pending={pending}
            disabled={!url.trim() || !selectedCreator}
          >
            Find shorts
          </Button>
        </form>
        <ApiError message={error} title="Couldn’t add this video" />
      </section>
      <AutopilotPanel
        statuses={autopilotStatuses}
        onToggle={onToggleAutopilot}
        onCheckNow={onCheckAutopilotNow}
        pendingCreatorIds={pendingAutopilotCreatorIds}
        error={autopilotError}
      />
      <section className="upcoming-posts" aria-labelledby="upcoming-title">
        <div className="section-heading">
          <div className="upcoming-heading">
            <h2 id="upcoming-title">Upcoming posts</h2>
            {upcomingPosts.length > 0 && <span className="upcoming-count">{upcomingPosts.length}</span>}
          </div>
          <span className="upcoming-zone">Posting time first · your local time below</span>
        </div>
        <ApiError message={scheduleError} title="Couldn’t load upcoming posts" />
        <ApiError message={cancelError} title="Couldn’t cancel the scheduled post" />
        {scheduleLoading && upcomingPosts.length === 0 ? (
          <div className="loading-state" role="status"><span className="spinner" />Loading upcoming posts…</div>
        ) : upcomingPosts.length > 0 ? (
          <ul className="upcoming-list" aria-label="Scheduled posts">
            {upcomingPosts.map((post) => {
              const date = new Date(post.scheduledFor);
              const platform = post.platform === 'instagram' ? 'Instagram' : post.platform === 'tiktok' ? 'TikTok' : 'YouTube Shorts';
              const cancellable = post.status === 'scheduled' || post.status === 'queued' || post.status === 'deferred';
              return (
                <li className="upcoming-post" key={post.publicationId}>
                  <PostingTime className="upcoming-time" dateTime={post.scheduledFor} timeZone={post.timeZone} />
                  <div className="upcoming-post-main">
                    <span className={`upcoming-platform upcoming-platform--${post.platform}`}>{platform}</span>
                    <Link to={`/shorts/${post.shortId}`} className="upcoming-short-link" title={post.shortTitle}>
                      {post.shortTitle}
                      <Icon name="arrow" size={15} />
                    </Link>
                    {post.status === 'publishing' && <span className="upcoming-post-note" role="status">Uploading now — cancellation is temporarily unavailable.</span>}
                    {post.status === 'queued' && <span className="upcoming-post-note">Sending to Mallary</span>}
                    {post.status === 'deferred' && <span className="upcoming-post-note">Waiting for the posting limit</span>}
                  </div>
                  <ScheduleCancelButton
                    description={`${platform} post “${post.shortTitle}” for ${postingDateFormatters(post.timeZone).dateTime.format(date)} · ${postingTimeZoneLabel(post.timeZone)}`}
                    pending={cancellingPublicationIds.includes(post.publicationId)}
                    disabled={!cancellable}
                    onConfirm={() => onCancelPublication(post.publicationId, post.shortId)}
                  />
                </li>
              );
            })}
          </ul>
        ) : !scheduleError ? (
          <div className="upcoming-empty">
            <span className="upcoming-empty-icon"><Icon name="clock" size={21} /></span>
            <div>
              <h3>No posts scheduled</h3>
              <p>Choose Schedule when publishing a short. Your upcoming posts will appear here.</p>
            </div>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">Source videos</h2>
          <span className="muted small">Most recently updated</span>
        </div>
        {loading ? (
          <div className="loading-state" role="status">
            <span className="spinner" />
            Loading your workspace…
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState title="Your next short starts here">
            Add a YouTube video above. Your transcript and proposed shorts will appear here.
          </EmptyState>
        ) : (
          <div className="job-list">
            {jobs.map((job) => (
              <Link className="job-row" key={job.id} to={`/jobs/${job.id}`}>
                <div className="job-thumbnail">
                  {job.thumbnailUrl ? (
                    <img src={job.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <Icon name="video" size={28} />
                  )}
                </div>
                <div className="job-row-main">
                  <div className="job-title-line">
                    <h3>{job.title || job.sourceUrl}</h3>
                    <StatusBadge status={job.status} />
                  </div>
                  <p className="job-meta">
                    {job.creator.displayName}
                    <span>·</span>
                    <time dateTime={job.updatedAt}>{relativeTime(job.updatedAt)}</time>
                  </p>
                  {job.error && job.status === 'failed' ? (
                    <p className="inline-error">{job.error}</p>
                  ) : (
                    <p className="job-progress">
                      {job.progress ||
                        (job.status === 'ready'
                          ? 'Ready for your review'
                          : 'Waiting for the next step')}
                    </p>
                  )}
                </div>
                <div className="job-counts">
                  <strong>
                    {job.shortCounts.active}
                    <span> shorts</span>
                  </strong>
                  <span>
                    {job.shortCounts.exported} exported
                    {job.shortCounts.rejected > 0 ? ` · ${job.shortCounts.rejected} rejected` : ''}
                  </span>
                </div>
                <Icon name="arrow" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </StudioShell>
  );
}
