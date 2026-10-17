import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobDetailDto, SpeakerSampleDto, TranscriptDto } from '@api';
import type { WordRange } from '@domain/edit';
import {
  ApiError,
  Button,
  EmptyState,
  Icon,
  StatusBadge,
  StudioShell,
  formatTime,
} from '../components/StudioPrimitives';
import { TranscriptPanel } from '../components/TranscriptPanel';
import '../styles/studio.css';

export interface SpeakerCardProps {
  speaker: SpeakerSampleDto;
  videoUrl?: string;
  pending?: boolean;
  onChoose: (speakerId: string) => void;
}
export function SpeakerCard({ speaker, videoUrl, pending, onChoose }: SpeakerCardProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [sampleIndex, setSampleIndex] = useState<number | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  useEffect(() => {
    const element = video.current;
    const sample = sampleIndex !== null ? speaker.samples[sampleIndex] : null;
    if (!element || !sample) return;
    element.currentTime = sample.startSeconds;
    void element
      .play()
      .catch(() => setPlayError('Playback could not start. Use the video controls to try again.'));
  }, [sampleIndex, speaker.samples]);
  return (
    <article className="speaker-card">
      <div className="section-heading">
        <h3>{speaker.speakerId}</h3>
        <span className="muted small">{formatTime(speaker.totalSeconds)} speaking</span>
      </div>
      {speaker.samples.map((sample, index) => (
        <div className="speaker-sample" key={`${sample.startSeconds}-${index}`}>
          <button
            className="sample-play"
            type="button"
            disabled={!videoUrl}
            aria-label={`Play sample at ${formatTime(sample.startSeconds)}`}
            onClick={() => {
              setPlayError(null);
              if (sampleIndex === index && video.current) {
                video.current.currentTime = sample.startSeconds;
                void video.current.play().catch(() => setPlayError('Playback could not start.'));
              } else setSampleIndex(index);
            }}
          >
            <Icon name="play" size={14} />
            <span>{formatTime(sample.startSeconds)}</span>
          </button>
          <p lang="pt-BR">{sample.text}</p>
        </div>
      ))}
      {sampleIndex !== null && videoUrl && (
        <video
          ref={video}
          src={videoUrl}
          className="speaker-video"
          controls
          preload="metadata"
          onTimeUpdate={() => {
            const sample = speaker.samples[sampleIndex];
            if (sample && video.current && video.current.currentTime >= sample.endSeconds)
              video.current.pause();
          }}
          onError={() => setPlayError('This sample could not be loaded.')}
        />
      )}
      <ApiError message={playError} />
      <Button variant="primary" pending={pending} onClick={() => onChoose(speaker.speakerId)}>
        Choose {speaker.speakerId}
      </Button>
    </article>
  );
}
export interface TranscriptRangeModalProps {
  transcript: TranscriptDto;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreate: (range: WordRange) => void;
}
export function TranscriptRangeModal({
  transcript,
  pending,
  error,
  onClose,
  onCreate,
}: TranscriptRangeModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selection, setSelection] = useState<WordRange | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const selectedWords = selection
    ? transcript.words.slice(selection.startWord, selection.endWord + 1)
    : [];
  const duration = selectedWords.length
    ? selectedWords[selectedWords.length - 1]!.end - selectedWords[0]!.start
    : 0;
  return (
    <dialog
      ref={dialog}
      className="range-modal"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      aria-labelledby="range-modal-title"
    >
      <div className="modal-heading">
        <div>
          <p className="eyebrow">MANUAL SHORT</p>
          <h2 id="range-modal-title">Find your own moment</h2>
        </div>
        <Button
          variant="ghost"
          icon="close"
          aria-label="Close transcript picker"
          disabled={pending}
          onClick={onClose}
        />
      </div>
      <TranscriptPanel
        transcript={transcript}
        ranges={[]}
        picker
        onSelectionChange={setSelection}
      />
      <div className="range-selection-preview">
        <span className="eyebrow">
          {selection ? `SELECTED · ${formatTime(duration)}` : 'NO SELECTION YET'}
        </span>
        <p lang="pt-BR">
          {selectedWords.map((word) => word.text).join(' ') ||
            'Select the words you want to build a short around.'}
        </p>
      </div>
      <ApiError message={error} />
      <div className="modal-footer">
        <Button onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="plus"
          pending={pending}
          disabled={!selection}
          onClick={() => {
            if (selection) onCreate(selection);
          }}
        >
          Create short
        </Button>
      </div>
    </dialog>
  );
}
export interface JobViewProps {
  job: JobDetailDto;
  transcript?: TranscriptDto | null;
  error?: string | null;
  retryPending?: boolean;
  speakerPending?: boolean;
  replanPending?: boolean;
  createPending?: boolean;
  statusPendingId?: string | null;
  onRetry: () => void;
  onChooseSpeaker: (speakerId: string) => void;
  onReplan: () => void;
  onCreateShort: (range: WordRange) => void;
  onSetShortStatus: (shortId: string, status: 'active' | 'rejected') => void;
}
export function JobView({
  job,
  transcript,
  error,
  retryPending,
  speakerPending,
  replanPending,
  createPending,
  statusPendingId,
  onRetry,
  onChooseSpeaker,
  onReplan,
  onCreateShort,
  onSetShortStatus,
}: JobViewProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [initialShortIds, setInitialShortIds] = useState<string[]>([]);
  const processing = ['queued', 'downloading', 'transcribing', 'planning'].includes(job.status);
  useEffect(() => {
    if (pickerOpen && job.shorts.some((short) => !initialShortIds.includes(short.id)))
      setPickerOpen(false);
  }, [job.shorts, initialShortIds, pickerOpen]);
  let body: ReactNode;
  if (job.status === 'awaiting_speaker')
    body = (
      <section>
        <div className="section-heading">
          <div>
            <h2>Who should we focus on?</h2>
            <p className="muted">Listen to a sample, then choose the main speaker.</p>
          </div>
        </div>
        <div className="speaker-grid">
          {job.speakers.map((speaker) => (
            <SpeakerCard
              key={speaker.speakerId}
              speaker={speaker}
              videoUrl={job.media?.videoUrl}
              pending={speakerPending}
              onChoose={onChooseSpeaker}
            />
          ))}
        </div>
      </section>
    );
  else
    body = (
      <section>
        <div className="section-heading shorts-heading">
          <div>
            <h2>
              Proposed shorts <span className="count-badge">{job.shorts.length}</span>
            </h2>
            <p className="muted">The strongest moments, ready for your touch.</p>
          </div>
          <div className="button-group">
            <Button
              icon="spark"
              onClick={onReplan}
              pending={replanPending}
              disabled={processing || !job.media}
            >
              Find more shorts
            </Button>
            <Button
              variant="primary"
              icon="plus"
              disabled={!transcript?.words.length}
              onClick={() => {
                setInitialShortIds(job.shorts.map((short) => short.id));
                setPickerOpen(true);
              }}
            >
              New short from transcript
            </Button>
          </div>
        </div>
        {job.shorts.length === 0 ? (
          <EmptyState title={processing ? 'Good moments take a moment.' : 'No shorts yet'}>
            {processing
              ? 'Your video is moving through the pipeline. Proposed shorts will appear here automatically.'
              : 'Find more shorts, or select a moment directly from the transcript.'}
          </EmptyState>
        ) : (
          <div className="shorts-grid">
            {job.shorts.map((short) => (
              <article
                key={short.id}
                className={`short-card ${short.status === 'rejected' ? 'short-card--rejected' : ''}`}
              >
                <div className="short-card-heading">
                  <span className="short-rank">{short.rank.toString().padStart(2, '0')}</span>
                  <span className="duration-chip">{formatTime(short.durationSeconds)}</span>
                  {short.status === 'rejected' && <StatusBadge status="rejected" />}
                </div>
                <h3>{short.title}</h3>
                <div className="hook-quote">
                  <span className="eyebrow">THE HOOK</span>
                  <p lang="pt-BR">{short.hookText || 'No hook yet'}</p>
                </div>
                <p className="short-summary" lang="pt-BR">
                  {short.summary}
                </p>
                <div className="card-statuses">
                  <StatusBadge status={short.cropAnalysis} />
                  {short.latestExport && (
                    <StatusBadge
                      status={short.latestExport.status}
                      label={`Export ${short.latestExport.status}`}
                    />
                  )}
                </div>
                <div className="short-card-footer">
                  <Button
                    variant="ghost"
                    pending={statusPendingId === short.id}
                    onClick={() =>
                      onSetShortStatus(
                        short.id,
                        short.status === 'rejected' ? 'active' : 'rejected',
                      )
                    }
                  >
                    {short.status === 'rejected' ? 'Restore' : 'Reject'}
                  </Button>
                  <Link className="button button--secondary" to={`/shorts/${short.id}`}>
                    Open editor
                    <Icon name="arrow" size={16} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  return (
    <StudioShell
      breadcrumb={
        <>
          <Link to="/">Source videos</Link>
          <span>/</span>
          <span className="truncate">{job.title || 'Source video'}</span>
        </>
      }
    >
      <Link className="back-link" to="/">
        <Icon name="back" size={16} />
        All source videos
      </Link>
      <section className="job-detail-header">
        <div className="detail-thumbnail">
          {job.thumbnailUrl ? (
            <img src={job.thumbnailUrl} alt="" />
          ) : (
            <Icon name="video" size={40} />
          )}
        </div>
        <div className="job-detail-info">
          <div className="button-group">
            <span className="eyebrow">{job.creator.displayName}</span>
            <StatusBadge status={job.status} />
          </div>
          <h1>{job.title || 'Untitled source video'}</h1>
          <a className="source-link" href={job.sourceUrl} target="_blank" rel="noreferrer">
            Watch source on YouTube
            <Icon name="external" size={14} />
          </a>
          {job.progress && <p className="muted">{job.progress}</p>}
        </div>
        {job.canRetry && (
          <Button icon="redo" pending={retryPending} onClick={onRetry}>
            Retry processing
          </Button>
        )}
      </section>
      <ApiError
        message={error || job.error}
        title={job.status === 'failed' ? 'Processing stopped' : 'Couldn’t complete that action'}
      />
      {processing && (
        <div className="pipeline-status" role="status">
          <span className="spinner" />
          <div>
            <strong>
              {job.status === 'queued'
                ? 'Your video is in the queue'
                : job.status === 'downloading'
                  ? 'Downloading the source video'
                  : job.status === 'transcribing'
                    ? 'Turning speech into a transcript'
                    : 'Finding the strongest moments'}
            </strong>
            <p>
              {job.progress || 'You can leave this page. Processing continues in the background.'}
            </p>
          </div>
          <div className="pipeline-steps">
            {['downloading', 'transcribing', 'planning'].map((step, index) => (
              <span
                key={step}
                className={
                  ['queued', 'downloading', 'transcribing', 'planning'].indexOf(job.status) > index
                    ? 'step-active'
                    : ''
                }
              >
                {index + 1}
              </span>
            ))}
          </div>
        </div>
      )}
      {body}
      {pickerOpen && transcript && (
        <TranscriptRangeModal
          transcript={transcript}
          pending={createPending}
          error={error}
          onClose={() => setPickerOpen(false)}
          onCreate={onCreateShort}
        />
      )}
    </StudioShell>
  );
}
