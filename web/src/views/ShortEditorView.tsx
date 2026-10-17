import type { Ref } from 'react';
import { Link } from 'react-router';
import type { TranscriptDto } from '@api';
import type { WordRange } from '@domain/edit';
import type { Timeline } from '@domain/timeline';
import { ApiError, Button, Icon } from '../components/StudioPrimitives';
import { EditorInspector, type EditorInspectorProps } from '../components/EditorInspector';
import { PreviewPanel } from '../components/PreviewPanel';
import { TranscriptPanel, type TranscriptAction } from '../components/TranscriptPanel';
import '../styles/studio.css';

export type AutosaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';
export interface ShortEditorViewProps extends EditorInspectorProps {
  transcript: TranscriptDto;
  timeline: Timeline;
  canvasRef: Ref<HTMLCanvasElement>;
  ready: boolean;
  playing: boolean;
  buffering: boolean;
  outputSeconds: number;
  activeWordIndex: number | null;
  autosave: AutosaveState;
  canUndo: boolean;
  canRedo: boolean;
  previewError?: string | null;
  toastError?: string | null;
  onDismissError?: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onTogglePlayback: () => void;
  onSeek: (seconds: number) => void;
  onSeekWord: (wordIndex: number) => void;
  onToggleWord: (wordIndex: number) => void;
  onRangeAction: (action: TranscriptAction, range: WordRange) => void;
  onSetBoundary: (rangeIndex: number, side: 'start' | 'end', wordIndex: number) => void;
}
const saveLabels: Record<AutosaveState, string> = {
  saved: 'All changes saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  conflict: 'Newer version loaded',
};
export function ShortEditorView(props: ShortEditorViewProps) {
  const {
    detail,
    edit,
    title,
    transcript,
    timeline,
    canvasRef,
    ready,
    playing,
    buffering,
    outputSeconds,
    activeWordIndex,
    autosave,
    canUndo,
    canRedo,
    previewError,
    toastError,
    onDismissError,
    onUndo,
    onRedo,
    onTogglePlayback,
    onSeek,
    onSeekWord,
    onToggleWord,
    onRangeAction,
    onSetBoundary,
    onExport,
    exportPending,
  } = props;
  const rendering = detail.exports.some(
    (item) => item.status === 'queued' || item.status === 'rendering',
  );
  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <Link
          className="editor-back"
          to={`/jobs/${detail.job.id}`}
          aria-label="Back to source video"
        >
          <Icon name="back" size={19} />
        </Link>
        <div className="editor-title">
          <span className="eyebrow">SHORT {detail.short.rank.toString().padStart(2, '0')}</span>
          <h1 title={title}>{title || 'Untitled short'}</h1>
        </div>
        <span className={`autosave autosave--${autosave}`} role="status">
          {autosave === 'saving' ? <span className="spinner" /> : <span className="save-dot" />}
          {saveLabels[autosave]}
        </span>
        <div className="editor-history">
          <Button
            variant="ghost"
            icon="undo"
            aria-label="Undo (Ctrl+Z)"
            title="Undo · Ctrl+Z"
            onClick={onUndo}
            disabled={!canUndo}
          />
          <Button
            variant="ghost"
            icon="redo"
            aria-label="Redo (Ctrl+Shift+Z)"
            title="Redo · Ctrl+Shift+Z"
            onClick={onRedo}
            disabled={!canRedo}
          />
        </div>
        <span className="history-hint">
          <kbd>Ctrl</kbd>
          <span>+</span>
          <kbd>Z</kbd>
        </span>
        <Button
          variant="primary"
          icon="download"
          pending={exportPending || rendering}
          onClick={onExport}
        >
          Export
        </Button>
      </header>
      <main className="editor-grid">
        <PreviewPanel
          canvasRef={canvasRef}
          timeline={timeline}
          ready={ready}
          playing={playing}
          buffering={buffering}
          outputSeconds={outputSeconds}
          error={previewError}
          hookMaxLines={detail.job.layout.hookBand?.maxLines}
          onTogglePlayback={onTogglePlayback}
          onSeek={onSeek}
        />
        <section className="transcript-column" aria-labelledby="transcript-title">
          <div className="column-heading">
            <h2 id="transcript-title">Transcript</h2>
            <div className="transcript-legend">
              <span>
                <i className="legend-kept" />
                In short
              </span>
              <span>
                <i className="legend-cut" />
                Cut
              </span>
            </div>
          </div>
          <TranscriptPanel
            transcript={transcript}
            ranges={edit.ranges}
            removedWords={edit.removedWords}
            activeWordIndex={activeWordIndex}
            onToggleWord={onToggleWord}
            onRangeAction={onRangeAction}
            onSetBoundary={onSetBoundary}
            onSeekWord={onSeekWord}
          />
        </section>
        <EditorInspector {...props} />
      </main>
      <footer className="editor-statusbar">
        <span>
          <span className="live-dot" />
          Live preview
        </span>
        <span>
          {edit.ranges.length} {edit.ranges.length === 1 ? 'range' : 'ranges'}
          <span className="status-separator">·</span>
          {timeline.clips.length} clips<span className="status-separator">·</span>
          {edit.speed.toFixed(2)}×
        </span>
        <span>
          <kbd>Space</kbd> play / pause<span className="status-separator">·</span>
          <kbd>Ctrl Shift Z</kbd> redo
        </span>
      </footer>
      {toastError && (
        <div className="toast-region">
          <ApiError message={toastError} onDismiss={onDismissError} />
        </div>
      )}
    </div>
  );
}
