import { useEffect, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router';
import type { TranscriptDto } from '@api';
import type { WordRange } from '@domain/edit';
import type { Timeline } from '@domain/timeline';
import { ApiError, Button, Icon } from '../components/StudioPrimitives';
import { EditorInspector, type EditorInspectorProps, type InspectorTab } from '../components/EditorInspector';
import { ExportFeedback, newestExport } from '../components/ExportFeedback';
import { PreviewPanel } from '../components/PreviewPanel';
import { TranscriptPanel, type TranscriptAction } from '../components/TranscriptPanel';
import '../styles/studio.css';

export type AutosaveState = 'saved' | 'saving' | 'unsaved' | 'conflict';
export interface ShortEditorViewProps extends Omit<EditorInspectorProps, 'tab' | 'onTabChange'> {
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
  onCorrectWord: (wordIndex: number, text: string) => void;
  correctingWordIndex: number | null;
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
    onCorrectWord,
    correctingWordIndex,
    onExport,
    exportPending,
  } = props;
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(props.initialTab ?? 'edit');
  const inspectorRegion = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<'transcript' | 'inspector'>(
    props.initialTab ? 'inspector' : 'transcript',
  );
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1120px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1120px)');
    const updateCompact = () => setCompact(media.matches);
    const viewport = window.visualViewport;
    const resize = () => {
      if (!viewport || viewport.scale !== 1) return;
      shell.current?.style.setProperty('--editor-viewport-height', `${viewport.height}px`);
      shell.current?.style.setProperty('--editor-viewport-top', `${viewport.offsetTop}px`);
    };
    resize();
    media.addEventListener('change', updateCompact);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      media.removeEventListener('change', updateCompact);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
    };
  }, []);
  const currentExport = newestExport(detail.exports, detail.short.editRevision);
  function showExport() {
    setInspectorTab('publish');
    setWorkspace('inspector');
    requestAnimationFrame(() => {
      const region = inspectorRegion.current;
      if (!region) return;
      region.querySelector('.inspector-scroll')?.scrollTo({ top: 0 });
      if (window.matchMedia('(max-width: 1120px)').matches) {
        document.getElementById('workspace-tab-inspector')?.focus({ preventScroll: true });
      }
    });
  }
  function startExport() {
    showExport();
    onExport();
  }
  const rendering = detail.exports.some(
    (item) => item.status === 'queued' || item.status === 'rendering',
  );
  return (
    <div className="editor-shell" ref={shell}>
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
        <div className="editor-export-actions">
          <ExportFeedback item={currentExport} pending={exportPending} compact onShowExport={showExport} />
          <Button
            variant={currentExport?.status === 'ready' ? 'secondary' : 'primary'}
            icon="download"
            pending={exportPending || rendering}
            onClick={startExport}
          >
            {exportPending ? 'Starting…' : rendering ? 'Exporting…' : currentExport?.status === 'failed' ? 'Retry export' : currentExport?.status === 'ready' ? 'Export again' : 'Export'}
          </Button>
        </div>
      </header>
      <main className="editor-grid" data-workspace={workspace}>
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
        <div className="editor-workspace-tabs" role="tablist" aria-label="Editor workspace">
          {(['transcript', 'inspector'] as const).map((name, index, names) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`workspace-tab-${name}`}
              aria-controls={`workspace-panel-${name}`}
              aria-selected={workspace === name}
              tabIndex={workspace === name ? 0 : -1}
              onClick={() => setWorkspace(name)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? names[0]
                  : event.key === 'End' ? names[1] : names[1 - index]!;
                setWorkspace(next);
                document.getElementById(`workspace-tab-${next}`)?.focus({ preventScroll: true });
              }}
            >
              {name === 'transcript' ? 'Transcript' : 'Inspector'}
            </button>
          ))}
        </div>
        <section
          className="transcript-column"
          id="workspace-panel-transcript"
          role={compact ? 'tabpanel' : 'region'}
          aria-labelledby={compact ? 'workspace-tab-transcript' : 'transcript-title'}
        >
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
            onCorrectWord={onCorrectWord}
            correctingWordIndex={correctingWordIndex}
          />
        </section>
        <div
          className="editor-inspector-region"
          ref={inspectorRegion}
          id="workspace-panel-inspector"
          role={compact ? 'tabpanel' : 'region'}
          aria-labelledby={compact ? 'workspace-tab-inspector' : undefined}
          aria-label={compact ? undefined : 'Inspector'}
        >
          <EditorInspector
            {...props}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            onExport={startExport}
          />
        </div>
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
