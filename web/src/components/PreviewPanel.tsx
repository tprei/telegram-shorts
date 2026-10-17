import type { Ref } from 'react';
import type { Timeline } from '@domain/timeline';
import { ApiError, Button, formatTime } from './StudioPrimitives';

export interface PreviewPanelProps {
  canvasRef: Ref<HTMLCanvasElement>;
  timeline: Timeline;
  ready: boolean;
  playing: boolean;
  buffering: boolean;
  outputSeconds: number;
  error?: string | null;
  hookMaxLines?: number;
  onTogglePlayback: () => void;
  onSeek: (seconds: number) => void;
}
export function PreviewPanel({
  canvasRef,
  timeline,
  ready,
  playing,
  buffering,
  outputSeconds,
  error,
  hookMaxLines,
  onTogglePlayback,
  onSeek,
}: PreviewPanelProps) {
  const duration = timeline.durationSeconds;
  const percent = duration > 0 ? Math.min(100, Math.max(0, (outputSeconds / duration) * 100)) : 0;
  const tooLong = duration > 180;
  const tooShort = duration < 15;
  const hookTooLong =
    hookMaxLines !== undefined && (timeline.hook?.lines.length ?? 0) > hookMaxLines;
  return (
    <section className="preview-column" aria-label="Live video preview">
      <div className="column-heading">
        <h2>Preview</h2>
        <span className="eyebrow">9:16 · 1080 × 1920</span>
      </div>
      <div className="preview-stage">
        <div className="canvas-frame">
          <canvas ref={canvasRef} width={1080} height={1920} aria-label="Vertical short preview" />
          {!ready && !error && (
            <div className="preview-overlay" role="status">
              <span className="spinner" />
              Preparing preview…
            </div>
          )}
          {buffering && ready && (
            <span className="buffering-indicator" role="status">
              <span className="spinner" />
              Buffering
            </span>
          )}
        </div>
      </div>
      <div className="preview-footer">
        <div className="transport">
          <Button
            variant="primary"
            icon={playing ? 'pause' : 'play'}
            onClick={onTogglePlayback}
            disabled={!ready || duration <= 0}
            aria-label={playing ? 'Pause preview' : 'Play preview'}
          />
          <span className="transport-time">
            <strong>{formatTime(outputSeconds)}</strong>
            <span>/ {formatTime(duration)}</span>
          </span>
          <kbd>Space</kbd>
          <span className={`duration-chip ${tooLong || tooShort ? 'duration-warning' : ''}`}>
            {duration.toFixed(1)}s
          </span>
        </div>
        <div className="timeline-scrubber">
          <div className="timeline-track" aria-hidden="true">
            {timeline.clips.map((clip) => (
              <span
                className="timeline-clip"
                key={clip.index}
                style={{
                  left: `${duration ? (clip.outputStart / duration) * 100 : 0}%`,
                  width: `${duration ? ((clip.outputEnd - clip.outputStart) / duration) * 100 : 0}%`,
                }}
              />
            ))}
            <span className="timeline-progress" style={{ width: `${percent}%` }} />
            <span className="timeline-playhead" style={{ left: `${percent}%` }} />
          </div>
          <input
            type="range"
            aria-label="Seek short preview"
            min={0}
            max={Math.max(0.01, duration)}
            step={0.01}
            value={Math.min(outputSeconds, Math.max(0.01, duration))}
            disabled={!ready}
            onChange={(event) => onSeek(Number(event.target.value))}
          />
        </div>
        <div className="timeline-labels">
          <span>0:00</span>
          <span>{timeline.clips.length} clips</span>
          <span>{formatTime(duration)}</span>
        </div>
        {tooLong && <p className="warning-note">Over 3 minutes — too long for YouTube Shorts.</p>}
        {tooShort && (
          <p className="warning-note">Under 15 seconds — consider a little more context.</p>
        )}
        {hookTooLong && (
          <p className="warning-note">
            The hook exceeds {hookMaxLines} lines. Shorten it to fit the hook band.
          </p>
        )}
        <ApiError message={error} title="Preview unavailable" />
        <p className="preview-note">Live preview · Changes appear as you edit</p>
      </div>
    </section>
  );
}
