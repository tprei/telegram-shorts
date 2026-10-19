import { useId } from 'react';
import type { SceneAnalysisDto } from '@api';
import type { Composition } from '@domain/layout';
import type { SceneSegment } from '@domain/model';
import { ApiError, Button, formatTime, Icon, Slider, Toggle } from './StudioPrimitives';
import '../styles/scene-layout.css';

export interface SceneLayoutSectionProps {
  analysis: SceneAnalysisDto;
  segment: SceneSegment | null;
  segmentIndex: number | null;
  segmentCount: number;
  sourceSeconds: number;
  selected: 'auto' | Composition;
  effectiveComposition: Composition | null;
  allowed: readonly Composition[];
  split: number | null;
  effectiveSplit: number | null;
  flashInherited: boolean;
  rerunPending: boolean;
  onCompositionChange: (composition: 'auto' | Composition) => void;
  onSplitChange: (split: number | null) => void;
  onSeekSegment: (index: number) => void;
  onAnalyzeScenes: () => void;
}

export interface SceneAnalysisGateProps {
  status: SceneAnalysisDto;
  onAnalyze: () => void;
  analyzePending: boolean;
}

const compositionLabels: Record<Composition, string> = {
  stack: 'Split',
  host: 'Host',
  content: 'Content',
};
const layoutChoices = ['auto', 'stack', 'host', 'content'] as const;

function sourceTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  return `${formatTime(tenths / 10)}.${tenths % 10}`;
}

function LayoutSchematic({ composition }: { composition: Composition }) {
  return (
    <svg className={`scene-layout-schematic scene-layout-schematic--${composition}`} width="22" height="36" viewBox="0 0 22 36" fill="none" aria-hidden="true">
      <rect className="scene-schematic-frame" x="1.5" y="1.5" width="19" height="33" rx="3" />
      {composition === 'stack' ? (
        <>
          <rect className="scene-schematic-content" x="4" y="4" width="14" height="15" rx="1" />
          <path className="scene-schematic-detail" d="M7 8h8M7 11h5" />
          <rect className="scene-schematic-host" x="4" y="21" width="14" height="11" rx="1" />
          <circle className="scene-schematic-face" cx="11" cy="25" r="2" />
          <path className="scene-schematic-face" d="M7 31a4 4 0 0 1 8 0" />
        </>
      ) : composition === 'host' ? (
        <>
          <rect className="scene-schematic-host" x="4" y="4" width="14" height="28" rx="1" />
          <circle className="scene-schematic-face" cx="11" cy="14" r="3.5" />
          <path className="scene-schematic-face" d="M5 29v-2a6 6 0 0 1 12 0v2" />
        </>
      ) : (
        <>
          <rect className="scene-schematic-content" x="4" y="4" width="14" height="28" rx="1" />
          <path className="scene-schematic-detail" d="M7 10h8M7 14h8M7 18h5M7 26h8" />
        </>
      )}
    </svg>
  );
}

export function SceneLayoutSection({
  analysis,
  segment,
  segmentIndex,
  segmentCount,
  sourceSeconds,
  selected,
  effectiveComposition,
  allowed,
  split,
  effectiveSplit,
  flashInherited,
  rerunPending,
  onCompositionChange,
  onSplitChange,
  onSeekSegment,
  onAnalyzeScenes,
}: SceneLayoutSectionProps) {
  const id = useId();
  const analyzing = analysis.status === 'queued' || analysis.status === 'running';
  const hasShot = segment !== null && segmentIndex !== null;
  const controlsDisabled = !hasShot || analyzing || rerunPending;
  const splitValue = split ?? effectiveSplit;
  const missingHost = segment !== null && segment.host === null;
  const missingContent = segment !== null && segment.content === null;
  const effectiveLabel = effectiveComposition === null ? null : compositionLabels[effectiveComposition];

  return (
    <section className="inspector-section scene-layout-section" aria-labelledby={`${id}-title`}>
      <div className="scene-layout-heading">
        <h3 className="eyebrow" id={`${id}-title`}>Layout</h3>
        <span className="scene-layout-scope">Per shot</span>
      </div>

      <div className="scene-shot">
        <div className="scene-shot-info" aria-live="polite" aria-atomic="true">
          <strong>{hasShot ? <>Shot {segmentIndex + 1} <span>of {segmentCount}</span></> : 'No active shot'}</strong>
          <span className="scene-shot-time" title={`Source playhead: ${sourceTime(sourceSeconds)}`}>
            {segment ? <>Source {sourceTime(segment.startSeconds)} – {sourceTime(segment.endSeconds)}</> : 'Scene analysis will find the shots.'}
          </span>
        </div>
        <nav className="scene-shot-navigation" aria-label="Shot navigation">
          <Button icon="back" aria-label="Previous shot" title="Previous shot" disabled={!hasShot || segmentIndex <= 0} onClick={() => {
            if (segmentIndex !== null) onSeekSegment(segmentIndex - 1);
          }} />
          <Button icon="arrow" aria-label="Next shot" title="Next shot" disabled={!hasShot || segmentIndex >= segmentCount - 1} onClick={() => {
            if (segmentIndex !== null) onSeekSegment(segmentIndex + 1);
          }} />
        </nav>
      </div>

      <div className="scene-layout-choices" role="group" aria-label="Layout for this shot" aria-describedby={hasShot ? `${id}-effective ${id}-availability` : undefined}>
        {layoutChoices.map((composition) => {
          const unavailable = composition !== 'auto' && !allowed.includes(composition);
          return (
            <button
              type="button"
              key={composition}
              className={`scene-layout-choice${selected === composition ? ' is-selected' : ''}`}
              aria-pressed={selected === composition}
              disabled={controlsDisabled || unavailable}
              onClick={() => onCompositionChange(composition)}
            >
              <span className="scene-layout-choice-icon">
                {composition === 'auto' ? <Icon name="spark" size={25} /> : <LayoutSchematic composition={composition} />}
              </span>
              <span>{composition === 'auto' ? 'Auto' : compositionLabels[composition]}</span>
            </button>
          );
        })}
      </div>

      <p className="scene-layout-effective" id={`${id}-effective`} aria-live="polite" aria-atomic="true">
        {effectiveLabel ? <><Icon name="check" size={13} /><span>{selected === 'auto' && !flashInherited ? 'Auto uses ' : 'Using '}<strong>{effectiveLabel}</strong></span></> : <span>No layout available yet</span>}
      </p>
      <div className="scene-layout-availability" id={`${id}-availability`}>
        {missingHost && <p><strong>{!allowed.includes('stack') ? 'Split, Host' : 'Host'}</strong><span>No host in this shot</span></p>}
        {missingContent && <p><strong>{!allowed.includes('stack') ? 'Split, Content' : 'Content'}</strong><span>No content in this shot</span></p>}
      </div>

      {flashInherited && segment && (
        <div className="scene-flash-note">
          <Icon name="clock" size={15} />
          <div><strong>Flash shot · {(segment.endSeconds - segment.startSeconds).toFixed(1)} s</strong><p>Uses the previous shot’s layout{effectiveLabel ? ` (${effectiveLabel})` : ''}, even with an override.</p></div>
        </div>
      )}

      <div className="scene-split">
        <div className="scene-split-heading">
          <h4>Split ratio</h4>
          <div className="scene-split-auto">
            <Toggle label="Auto" description="Choose the split ratio automatically" checked={split === null} disabled={controlsDisabled || splitValue === null} onChange={(auto) => {
              if (auto) onSplitChange(null);
              else if (effectiveSplit !== null) onSplitChange(effectiveSplit);
            }} />
          </div>
        </div>
        {splitValue !== null ? (
          <Slider label="Content share" min={40} max={65} step={1} value={Math.round(splitValue * 100)} display={`${Math.round(splitValue * 100)}%${split === null ? ' · Auto' : ''}`} disabled={controlsDisabled || split === null} onChange={(value) => onSplitChange(value / 100)} />
        ) : <p className="scene-layout-help">Available after scene analysis.</p>}
        <p className="scene-layout-help">One ratio for all split shots in this short.</p>
      </div>

      <div className="scene-analysis-controls">
        {analyzing && (
          <div className="scene-analysis-status" role="status">
            {analysis.status === 'running' ? <span className="spinner" aria-hidden="true" /> : <Icon name="clock" size={15} />}
            <div><strong>{analysis.status === 'queued' ? 'Scene analysis queued' : 'Analyzing scenes…'}</strong><p>Layouts will be editable when analysis finishes.</p></div>
          </div>
        )}
        {analysis.status === 'failed' && <ApiError title="Scene analysis failed" message={analysis.error ?? 'Scenes could not be analyzed. Re-analyze to try again.'} />}
        <Button className="full-width" icon="spark" pending={rerunPending} disabled={analyzing} onClick={onAnalyzeScenes}>Re-analyze scenes</Button>
      </div>
    </section>
  );
}

export function SceneAnalysisGate({ status, onAnalyze, analyzePending }: SceneAnalysisGateProps) {
  const id = useId();
  const queued = status.status === 'queued';
  const running = status.status === 'running';
  const failed = status.status === 'failed';
  const busy = queued || running || analyzePending;

  return (
    <section className="scene-analysis-gate" aria-labelledby={`${id}-title`}>
      <div className={`scene-analysis-gate-card${failed ? ' has-error' : ''}`}>
        <div className="scene-analysis-gate-mark" aria-hidden="true">
          <LayoutSchematic composition="stack" />
          <LayoutSchematic composition="host" />
          <LayoutSchematic composition="content" />
        </div>
        <p className="eyebrow">Scene layouts</p>
        <div role="status" aria-live="polite" aria-atomic="true">
          <h1 id={`${id}-title`}>{failed ? 'Scene analysis needs another try' : queued ? 'Scene analysis is queued' : running || analyzePending ? 'Finding the right layout for each shot' : 'Scene layouts aren’t ready yet'}</h1>
          <p className="scene-analysis-gate-copy">{failed ? 'The editor will open once the shots are ready.' : queued ? 'Your video is waiting to be analyzed. The editor will open automatically when it’s ready.' : running || analyzePending ? 'Finding the host and content in your video. The editor will open automatically when it’s ready.' : 'Analyze the source video to open this short in the editor.'}</p>
        </div>
        {failed && <ApiError title="Scene analysis failed" message={status.error ?? 'Scenes could not be analyzed. Try again.'} />}
        {busy ? (
          <div className="scene-analysis-gate-progress" role="status">
            {queued && !analyzePending ? <Icon name="clock" size={16} /> : <span className="spinner" aria-hidden="true" />}
            <span>{analyzePending ? 'Requesting analysis…' : queued ? 'Waiting to start' : 'Analyzing scenes…'}</span>
          </div>
        ) : <Button variant="primary" icon="spark" onClick={onAnalyze}>{failed ? 'Re-analyze scenes' : 'Analyze scenes'}</Button>}
      </div>
    </section>
  );
}
