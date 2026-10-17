import type { ExportDto } from '@api';
import { Icon } from './StudioPrimitives';

export function newestExport(exports: readonly ExportDto[]): ExportDto | null {
  let newest: ExportDto | null = null;
  for (const item of exports) {
    if (!item.current) continue;
    if (!newest || item.createdAt > newest.createdAt) newest = item;
  }
  return newest;
}

export interface ExportFeedbackProps {
  item: ExportDto | null;
  pending?: boolean;
  compact?: boolean;
  onShowExport?: () => void;
}

export function ExportFeedback({ item, pending = false, compact = false, onShowExport }: ExportFeedbackProps) {
  const status = pending ? 'starting' : item?.status;
  if (!status) return null;
  const busy = status === 'starting' || status === 'queued' || status === 'rendering';
  const label = status === 'starting'
    ? 'Starting export…'
    : status === 'queued'
      ? 'Export queued'
      : status === 'rendering'
        ? 'Rendering video…'
        : status === 'ready'
          ? 'Export ready'
          : 'Export failed';
  const description = status === 'starting'
    ? 'Preparing your short for rendering.'
    : status === 'queued'
      ? 'Your short is in the render queue. You can keep editing.'
      : status === 'rendering'
        ? 'Burning in captions and finishing your video. You can keep editing.'
        : status === 'ready'
          ? 'Your MP4 is ready to watch and download.'
          : item?.error || 'The video could not be rendered. Try exporting again.';
  return (
    <div className={`export-feedback export-feedback--${status}${compact ? ' export-feedback--compact' : ''}`}>
      <div className="export-feedback-copy" role={status === 'failed' ? 'alert' : 'status'} aria-atomic="true">
        <span className="export-feedback-icon" aria-hidden="true">
          {busy ? <span className="spinner" /> : <Icon name={status === 'ready' ? 'check' : 'alert'} size={17} />}
        </span>
        <div>
          <strong>{label}</strong>
          {!compact && <p>{description}</p>}
        </div>
      </div>
      {compact && status === 'failed' && <p className="export-feedback-error" title={description}>{description}</p>}
      {compact && status === 'ready' && item?.videoUrl ? (
        <a className="button button--primary" href={item.videoUrl} download={`short-${item.shortId}-r${item.editRevision}.mp4`}>
          <Icon name="download" size={16} /> Download MP4
        </a>
      ) : compact && onShowExport ? (
        <button type="button" className="export-feedback-details" onClick={onShowExport}>
          {status === 'failed' ? 'Review export' : 'View export'} <Icon name="arrow" size={14} />
        </button>
      ) : null}
      {!compact && busy && <div className="export-progress" aria-hidden="true"><span /></div>}
    </div>
  );
}
