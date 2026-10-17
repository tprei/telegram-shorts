import { useState, type KeyboardEvent } from 'react';
import type { HookSuggestionsDto, ShortDetailDto } from '@api';
import { EDIT_LIMITS, type ShortEdit } from '@domain/edit';
import type { NormRect } from '@domain/layout';
import type { PublishCopy, ShortVideoPlatform } from '@domain/model';
import {
  ApiError,
  Button,
  Slider,
  StatusBadge,
  Toggle,
  formatTime,
  relativeTime,
} from './StudioPrimitives';
import { CropEditor } from './CropEditor';
import { ExportFeedback, newestExport } from './ExportFeedback';
import { PublishPanel } from './PublishPanel';

export type InspectorTab = 'edit' | 'framing' | 'revise' | 'publish';
export interface RevisionSummary {
  id: string;
  summary: string;
  warnings: string[];
}
export interface EditorInspectorProps {
  detail: ShortDetailDto;
  edit: ShortEdit;
  title: string;
  frameUrl: (sourceSeconds: number, width: number) => string;
  hookSuggestions?: HookSuggestionsDto | null;
  hooksPending?: boolean;
  revisePending?: boolean;
  revisions?: RevisionSummary[];
  exportPending?: boolean;
  publishCopy: PublishCopy | null;
  copyPending?: boolean;
  selectedPlatforms: ShortVideoPlatform[];
  publishPending?: boolean;
  error?: string | null;
  initialTab?: InspectorTab;
  tab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
  onTitleChange: (title: string) => void;
  onEditChange: (edit: ShortEdit) => void;
  onSuggestHooks: () => void;
  onCropChange: (index: number, focus: NormRect) => void;
  onAddCrop: () => void;
  onDeleteCrop: (index: number) => void;
  onAnalyzeCrops: () => void;
  onRevise: (message: string) => void;
  onExport: () => void;
  onGenerateCopy: () => void;
  onPublishCopyChange: (copy: PublishCopy) => void;
  onSelectedPlatformsChange: (platforms: ShortVideoPlatform[]) => void;
  onPublish: (force: boolean, platforms: ShortVideoPlatform[]) => void;
}
const tabLabels: Record<InspectorTab, string> = {
  edit: 'Edit',
  framing: 'Framing',
  revise: 'Revise',
  publish: 'Export & publish',
};
export function EditorInspector(props: EditorInspectorProps) {
  const {
    detail,
    edit,
    title,
    frameUrl,
    hookSuggestions,
    hooksPending,
    revisePending,
    revisions = [],
    exportPending,
    publishCopy: savedPublishCopy,
    copyPending,
    selectedPlatforms,
    publishPending,
    error,
    onTitleChange,
    onEditChange,
    onSuggestHooks,
    onCropChange,
    onAddCrop,
    onDeleteCrop,
    onAnalyzeCrops,
    onRevise,
    onExport,
    onGenerateCopy,
    onPublishCopyChange,
    onSelectedPlatformsChange,
    onPublish,
  } = props;
  const [internalTab, setInternalTab] = useState<InspectorTab>(props.initialTab ?? 'edit');
  const tab = props.tab ?? internalTab;
  function setTab(next: InspectorTab) {
    setInternalTab(next);
    props.onTabChange?.(next);
  }
  const [cropIndex, setCropIndex] = useState(0);
  const [revisionMessage, setRevisionMessage] = useState('');
  const [hashtagDraft, setHashtagDraft] = useState('');
  const publishCopy: PublishCopy = savedPublishCopy ?? { line1: '', line2: '', hashtags: [] };
  const copyReady = Boolean(
    publishCopy.line1.trim() && publishCopy.line2.trim() && publishCopy.hashtags.length,
  );
  const crop = edit.crops[cropIndex];
  const contentRegion = detail.job.layout.panels.find((panel) => panel.role === 'content')
    ?.sourceRect ?? { x: 0, y: 0, w: 1, h: 1 };
  const analyzing =
    detail.short.cropAnalysis === 'queued' || detail.short.cropAnalysis === 'running';
  const currentExport = newestExport(detail.exports, detail.short.editRevision);
  const latestReadyExport = detail.exports.find((item) => item.status === 'ready') ?? null;
  const rendering = detail.exports.some(
    (item) => item.status === 'queued' || item.status === 'rendering',
  );
  function addHashtag(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    const tag = hashtagDraft.trim().replace(/^#+/, '');
    if (!tag || publishCopy.hashtags.length >= 6) return;
    const hashtag = `#${tag}`;
    if (!publishCopy.hashtags.includes(hashtag))
      onPublishCopyChange({ ...publishCopy, hashtags: [...publishCopy.hashtags, hashtag] });
    setHashtagDraft('');
  }
  return (
    <aside className="inspector-column" aria-label="Short inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
        {(Object.keys(tabLabels) as InspectorTab[]).map((name, index, names) => (
          <button
            type="button"
            role="tab"
            id={`inspector-tab-${name}`}
            aria-controls={`inspector-panel-${name}`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            className={tab === name ? 'is-active' : ''}
            key={name}
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowRight' ||
                event.key === 'ArrowLeft' ||
                event.key === 'Home' ||
                event.key === 'End'
              ) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? names[0]!
                    : event.key === 'End'
                      ? names[names.length - 1]!
                      : names[
                          (index + (event.key === 'ArrowRight' ? 1 : names.length - 1)) %
                            names.length
                        ]!;
                setTab(next);
                document.getElementById(`inspector-tab-${next}`)?.focus();
              }
            }}
          >
            {tabLabels[name]}
          </button>
        ))}
      </div>
      <div
        className="inspector-scroll"
        role="tabpanel"
        id={`inspector-panel-${tab}`}
        aria-labelledby={`inspector-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'edit' && (
          <>
            <section className="inspector-section">
              <p className="eyebrow">THE STORY</p>
              <label className="field">
                <span>Short title</span>
                <input
                  value={title}
                  maxLength={200}
                  onChange={(event) => onTitleChange(event.target.value)}
                />
              </label>
              <div className="field-line">
                <label htmlFor="hook-text">Hook headline</label>
                <span
                  className={
                    edit.hook.text.length >= EDIT_LIMITS.maxHookChars
                      ? 'warning-text small'
                      : 'muted small'
                  }
                >
                  {edit.hook.text.length}/{EDIT_LIMITS.maxHookChars}
                </span>
              </div>
              <textarea
                id="hook-text"
                className="hook-input"
                value={edit.hook.text}
                maxLength={EDIT_LIMITS.maxHookChars}
                rows={3}
                lang="pt-BR"
                onChange={(event) =>
                  onEditChange({ ...edit, hook: { ...edit.hook, text: event.target.value } })
                }
              />
              <Toggle
                label="Show hook"
                description="Headline in the top band"
                checked={edit.hook.enabled}
                onChange={(enabled) => onEditChange({ ...edit, hook: { ...edit.hook, enabled } })}
              />
              <Button
                className="full-width"
                icon="spark"
                onClick={onSuggestHooks}
                pending={hooksPending}
              >
                Suggest hooks
              </Button>
              {hookSuggestions && (
                <div className="hook-suggestions" aria-label="Suggested hooks">
                  {hookSuggestions.options.slice(0, 3).map((option, index) => (
                    <button
                      type="button"
                      key={`${option}-${index}`}
                      lang="pt-BR"
                      onClick={() =>
                        onEditChange({
                          ...edit,
                          hook: { enabled: true, text: option.slice(0, EDIT_LIMITS.maxHookChars) },
                        })
                      }
                    >
                      <span>{index + 1}</span>
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="inspector-section">
              <p className="eyebrow">PACE & RHYTHM</p>
              <Slider
                label="Playback speed"
                value={edit.speed}
                min={EDIT_LIMITS.minSpeed}
                max={EDIT_LIMITS.maxSpeed}
                step={0.05}
                display={`${edit.speed.toFixed(2)}×`}
                onChange={(speed) => onEditChange({ ...edit, speed })}
              />
              <Toggle
                label="Tighten pauses"
                description="Keep the conversation moving"
                checked={edit.tightenPauses.enabled}
                onChange={(enabled) =>
                  onEditChange({ ...edit, tightenPauses: { ...edit.tightenPauses, enabled } })
                }
              />
              <Slider
                label="Maximum pause"
                value={edit.tightenPauses.maxGapSeconds}
                min={EDIT_LIMITS.minPauseGapSeconds}
                max={EDIT_LIMITS.maxPauseGapSeconds}
                step={0.05}
                display={`${edit.tightenPauses.maxGapSeconds.toFixed(2)}s`}
                disabled={!edit.tightenPauses.enabled}
                onChange={(maxGapSeconds) =>
                  onEditChange({ ...edit, tightenPauses: { ...edit.tightenPauses, maxGapSeconds } })
                }
              />
            </section>
            <section className="inspector-section">
              <p className="eyebrow">ON SCREEN</p>
              <Toggle
                label="Captions"
                description="Word-by-word, in sync"
                checked={edit.captions.enabled}
                onChange={(enabled) => onEditChange({ ...edit, captions: { enabled } })}
              />
              <Toggle
                label="Dynamic zoom"
                description="A little movement between cuts"
                checked={edit.zoom.enabled}
                onChange={(enabled) => onEditChange({ ...edit, zoom: { ...edit.zoom, enabled } })}
              />
              <Slider
                label="Zoom strength"
                value={edit.zoom.strength}
                min={EDIT_LIMITS.minZoom}
                max={EDIT_LIMITS.maxZoom}
                step={0.01}
                display={`${edit.zoom.strength.toFixed(2)}×`}
                disabled={!edit.zoom.enabled}
                onChange={(strength) => onEditChange({ ...edit, zoom: { ...edit.zoom, strength } })}
              />
              <Toggle
                label="End card"
                description="Point viewers to the full video"
                checked={edit.endCard.enabled}
                onChange={(enabled) => onEditChange({ ...edit, endCard: { enabled } })}
              />
            </section>
          </>
        )}
        {tab === 'framing' && (
          <>
            <section className="inspector-section">
              <div className="field-line">
                <div>
                  <p className="eyebrow">SOURCE FRAMING</p>
                  <h3>Keep the focus right</h3>
                </div>
                <StatusBadge status={detail.short.cropAnalysis} />
              </div>
              <p className="field-help">
                Keyframes follow source time. Manual changes stay in your hands.
              </p>
              <Button className="full-width" icon="plus" onClick={onAddCrop}>
                Add keyframe at playhead
              </Button>
              <div className="keyframe-list">
                {edit.crops.map((keyframe, index) => (
                  <button
                    type="button"
                    key={`${keyframe.sourceSeconds}-${index}`}
                    className={`keyframe-item ${cropIndex === index ? 'is-selected' : ''}`}
                    aria-pressed={cropIndex === index}
                    onClick={() => setCropIndex(index)}
                  >
                    <img src={frameUrl(keyframe.sourceSeconds, 240)} alt="" loading="lazy" />
                    <span>
                      <strong>{formatTime(keyframe.sourceSeconds)}</strong>
                      <span>{keyframe.origin}</span>
                    </span>
                    <span className="keyframe-number">{index + 1}</span>
                  </button>
                ))}
              </div>
              {edit.crops.length === 0 && (
                <p className="field-help">
                  No keyframes yet. Add one at the playhead or analyze the source.
                </p>
              )}
              {crop && (
                <CropEditor
                  keyframe={crop}
                  frameUrl={frameUrl(crop.sourceSeconds, 960)}
                  sourceAspectRatio={detail.job.media.width / detail.job.media.height}
                  contentRegion={contentRegion}
                  onChange={(focus) => onCropChange(cropIndex, focus)}
                  onDelete={() => {
                    onDeleteCrop(cropIndex);
                    setCropIndex(Math.max(0, cropIndex - 1));
                  }}
                />
              )}
            </section>
            <section className="inspector-section">
              <Button
                className="full-width"
                icon="spark"
                pending={analyzing}
                onClick={onAnalyzeCrops}
              >
                Re-analyze crops
              </Button>
              <ApiError message={detail.short.cropAnalysisError} title="Crop analysis failed" />
            </section>
          </>
        )}
        {tab === 'revise' && (
          <>
            <section className="inspector-section">
              <p className="eyebrow">A SECOND PAIR OF HANDS</p>
              <h3>What would you change?</h3>
              <p className="field-help">
                Ask in English or Portuguese. Your changes stay editable.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (revisionMessage.trim()) onRevise(revisionMessage.trim());
                }}
              >
                <label className="field">
                  <span>Change request</span>
                  <textarea
                    rows={7}
                    placeholder="Start at the point about interest rates, remove the repetition, and make the hook sharper…"
                    value={revisionMessage}
                    maxLength={2000}
                    disabled={revisePending}
                    onChange={(event) => setRevisionMessage(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  className="full-width"
                  icon="spark"
                  pending={revisePending}
                  disabled={!revisionMessage.trim()}
                >
                  Apply revision
                </Button>
              </form>
            </section>
            <section className="inspector-section">
              <p className="eyebrow">APPLIED REVISIONS</p>
              {revisions.length === 0 ? (
                <p className="field-help">Your revision history will appear here.</p>
              ) : (
                revisions.map((revision, index) => (
                  <article className="revision-entry" key={revision.id}>
                    <span className="revision-number">{index + 1}</span>
                    <div>
                      <p>{revision.summary}</p>
                      {revision.warnings.map((warning, warningIndex) => (
                        <p className="warning-note" key={warningIndex}>
                          {warning}
                        </p>
                      ))}
                    </div>
                  </article>
                ))
              )}
            </section>
          </>
        )}
        {tab === 'publish' && (
          <>
            <section className="inspector-section">
              <p className="eyebrow">READY WHEN YOU ARE</p>
              <div className="field-line">
                <h3>Export your short</h3>
                <span className="muted small">1080 × 1920 MP4</span>
              </div>
              <ExportFeedback item={currentExport} pending={exportPending} />
              <Button
                variant="primary"
                className="full-width"
                icon="download"
                pending={exportPending || rendering}
                onClick={onExport}
              >
                {currentExport?.status === 'failed' ? 'Try export again' : currentExport?.status === 'ready' ? 'Export again' : 'Export video'}
              </Button>
              <div className="export-list">
                {[...detail.exports].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((item) => (
                  <article className={`export-item${item.id === currentExport?.id ? ' export-item--current' : ''}`} key={item.id}>
                    <div className="field-line">
                      <span className="small">
                        {item.id === currentExport?.id ? 'Current edit' : `Revision ${item.editRevision}`} · {relativeTime(item.createdAt)}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    {item.status === 'ready' && item.videoUrl && (
                      <>
                        <video
                          controls
                          src={item.videoUrl}
                          poster={item.coverUrl ?? undefined}
                          preload="none"
                          aria-label={`Export revision ${item.editRevision}`}
                        />
                        <a
                          className="download-link"
                          href={item.videoUrl}
                          download={`short-${item.shortId}-r${item.editRevision}.mp4`}
                        >
                          Download MP4
                          {item.sizeBytes ? ` · ${(item.sizeBytes / 1048576).toFixed(1)} MB` : ''}
                        </a>
                      </>
                    )}
                    {item.status === 'failed' && item.id !== currentExport?.id && (
                      <ApiError message={item.error || 'The video could not be rendered.'} title="Export failed" />
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="inspector-section">
              <div className="field-line">
                <h3>Publish copy</h3>
                <Button variant="ghost" icon="spark" pending={copyPending} onClick={onGenerateCopy}>
                  Generate
                </Button>
              </div>
              <label className="field">
                <span>Line 1</span>
                <input
                  value={publishCopy.line1}
                  maxLength={180}
                  lang="pt-BR"
                  onChange={(event) =>
                    onPublishCopyChange({ ...publishCopy, line1: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Line 2</span>
                <input
                  value={publishCopy.line2}
                  maxLength={180}
                  lang="pt-BR"
                  onChange={(event) =>
                    onPublishCopyChange({ ...publishCopy, line2: event.target.value })
                  }
                />
              </label>
              <div className="field">
                <label htmlFor="publish-hashtag">
                  Hashtags <span className="muted">({publishCopy.hashtags.length}/6)</span>
                </label>
                <div className="hashtag-editor">
                  {publishCopy.hashtags.map((tag, index) => (
                    <span className="hashtag-chip" key={`${tag}-${index}`}>
                      {tag}
                      <button
                        type="button"
                        aria-label={`Remove ${tag}`}
                        onClick={() =>
                          onPublishCopyChange({
                            ...publishCopy,
                            hashtags: publishCopy.hashtags.filter(
                              (_, tagIndex) => tagIndex !== index,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="publish-hashtag"
                    aria-label="Add hashtag, then press Enter"
                    placeholder={
                      publishCopy.hashtags.length < 6 ? 'Add tag + Enter' : 'Six tags maximum'
                    }
                    value={hashtagDraft}
                    maxLength={39}
                    disabled={publishCopy.hashtags.length >= 6}
                    onChange={(event) => setHashtagDraft(event.target.value)}
                    onKeyDown={addHashtag}
                  />
                </div>
              </div>
            </section>
            <PublishPanel
              latestReadyExport={latestReadyExport}
              exports={detail.exports}
              publications={detail.publications}
              platforms={detail.platforms}
              selectedPlatforms={selectedPlatforms}
              publishPending={publishPending}
              copyReady={copyReady}
              onSelectedPlatformsChange={onSelectedPlatformsChange}
              onPublish={onPublish}
            />
          </>
        )}
        <ApiError message={error} />
      </div>
    </aside>
  );
}
