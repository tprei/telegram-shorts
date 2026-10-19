import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { CropKeyframe } from '@domain/edit';
import type { NormRect } from '@domain/layout';
import { Button, formatTime } from './StudioPrimitives';

export interface CropEditorProps {
  keyframe: CropKeyframe;
  frameUrl: string;
  sourceAspectRatio: number;
  contentRegion: NormRect;
  focusSpace?: 'source' | 'content';
  onChange: (focus: NormRect) => void;
  onDelete: () => void;
}
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
interface CropGesture {
  handle: Handle;
  x: number;
  y: number;
  focus: NormRect;
  width: number;
  height: number;
}
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
const SOURCE_BOUNDS: NormRect = { x: 0, y: 0, w: 1, h: 1 };
function focusInRegion(focus: NormRect, region: NormRect): NormRect {
  return {
    x: region.x + focus.x * region.w,
    y: region.y + focus.y * region.h,
    w: focus.w * region.w,
    h: focus.h * region.h,
  };
}
function focusInContent(focus: NormRect, region: NormRect): NormRect {
  return {
    x: (focus.x - region.x) / region.w,
    y: (focus.y - region.y) / region.h,
    w: focus.w / region.w,
    h: focus.h / region.h,
  };
}
function rectStyle(rect: NormRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}
export function CropEditor({
  keyframe,
  frameUrl,
  sourceAspectRatio,
  contentRegion,
  focusSpace = 'source',
  onChange,
  onDelete,
}: CropEditorProps) {
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<CropGesture | null>(null);
  const contentLocal = focusSpace === 'content';
  const bounds = contentLocal ? contentRegion : SOURCE_BOUNDS;
  const displayedFocus = contentLocal ? focusInRegion(keyframe.focus, contentRegion) : keyframe.focus;
  function emit(focus: NormRect) {
    onChange(contentLocal ? focusInContent(focus, contentRegion) : focus);
  }
  function down(event: PointerEvent<HTMLElement>, handle: Handle) {
    event.preventDefault();
    event.stopPropagation();
    const surfaceBounds = surface.current?.getBoundingClientRect();
    if (!surfaceBounds) return;
    gesture.current = {
      handle,
      x: event.clientX,
      y: event.clientY,
      focus: displayedFocus,
      width: surfaceBounds.width,
      height: surfaceBounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current) return;
    const dx = (event.clientX - current.x) / current.width;
    const dy = (event.clientY - current.y) / current.height;
    const f = current.focus;
    if (current.handle === 'move') {
      emit({
        ...f,
        x: clamp(f.x + dx, bounds.x, bounds.x + bounds.w - f.w),
        y: clamp(f.y + dy, bounds.y, bounds.y + bounds.h - f.h),
      });
      return;
    }
    const left = current.handle.endsWith('w') ? clamp(f.x + dx, bounds.x, f.x + f.w - 0.02) : f.x;
    const top = current.handle.startsWith('n') ? clamp(f.y + dy, bounds.y, f.y + f.h - 0.02) : f.y;
    const right = current.handle.endsWith('e') ? clamp(f.x + f.w + dx, f.x + 0.02, bounds.x + bounds.w) : f.x + f.w;
    const bottom = current.handle.startsWith('s')
      ? clamp(f.y + f.h + dy, f.y + 0.02, bounds.y + bounds.h)
      : f.y + f.h;
    emit({ x: left, y: top, w: right - left, h: bottom - top });
  }
  function keyDown(event: KeyboardEvent<HTMLElement>, handle: Handle) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 0.025 : 0.005;
    const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
    const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
    const f = displayedFocus;
    if (handle === 'move') {
      emit({
        ...f,
        x: clamp(f.x + dx, bounds.x, bounds.x + bounds.w - f.w),
        y: clamp(f.y + dy, bounds.y, bounds.y + bounds.h - f.h),
      });
    } else {
      const left = handle.endsWith('w') ? clamp(f.x + dx, bounds.x, f.x + f.w - 0.02) : f.x;
      const top = handle.startsWith('n') ? clamp(f.y + dy, bounds.y, f.y + f.h - 0.02) : f.y;
      const right = handle.endsWith('e') ? clamp(f.x + f.w + dx, f.x + 0.02, bounds.x + bounds.w) : f.x + f.w;
      const bottom = handle.startsWith('s') ? clamp(f.y + f.h + dy, f.y + 0.02, bounds.y + bounds.h) : f.y + f.h;
      emit({ x: left, y: top, w: right - left, h: bottom - top });
    }
  }
  return (
    <section className="crop-editor" aria-label={`Crop at ${formatTime(keyframe.sourceSeconds)}`}>
      <div className="field-line">
        <strong>Focus at {formatTime(keyframe.sourceSeconds)}</strong>
        <span className="muted small">{keyframe.origin}</span>
      </div>
      <div className="crop-surface" ref={surface} style={{ aspectRatio: sourceAspectRatio }}>
        <img
          src={frameUrl}
          alt={`Source video frame at ${formatTime(keyframe.sourceSeconds)}`}
          draggable={false}
        />
        <div className="content-region" style={rectStyle(contentRegion)}>
          <span>Content</span>
        </div>
        <div
          className="crop-focus"
          style={rectStyle(displayedFocus)}
          role="group"
          aria-label="Focus rectangle"
        >
          <button
            type="button"
            className="crop-move"
            aria-label="Move focus rectangle with arrow keys"
            onPointerDown={(event) => down(event, 'move')}
            onPointerMove={move}
            onPointerUp={() => {
              gesture.current = null;
            }}
            onPointerCancel={() => {
              gesture.current = null;
            }}
            onKeyDown={(event) => keyDown(event, 'move')}
          />
          <span className="crop-crosshair" aria-hidden="true">
            +
          </span>
          {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
            <button
              type="button"
              className={`crop-resize crop-resize--${handle}`}
              key={handle}
              aria-label={`Resize ${handle === 'nw' ? 'top left' : handle === 'ne' ? 'top right' : handle === 'sw' ? 'bottom left' : 'bottom right'} corner with arrow keys`}
              onPointerDown={(event) => down(event, handle)}
              onPointerMove={move}
              onPointerUp={() => {
                gesture.current = null;
              }}
              onPointerCancel={() => {
                gesture.current = null;
              }}
              onKeyDown={(event) => keyDown(event, handle)}
            />
          ))}
        </div>
      </div>
      <p className="field-help">
        Drag to move. Use a corner to resize freely. Arrow keys fine-tune; Shift moves faster.
      </p>
      <div className="crop-coordinates">
        <span>X {(keyframe.focus.x * 100).toFixed(1)}%</span>
        <span>Y {(keyframe.focus.y * 100).toFixed(1)}%</span>
        <span>W {(keyframe.focus.w * 100).toFixed(1)}%</span>
        <span>H {(keyframe.focus.h * 100).toFixed(1)}%</span>
      </div>
      <Button variant="danger" onClick={onDelete}>
        Delete keyframe
      </Button>
    </section>
  );
}
