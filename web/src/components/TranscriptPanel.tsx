import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useBlocker } from 'react-router';
import type { TranscriptDto, TranscriptWordDto } from '@api';
import type { WordRange } from '@domain/edit';
import { Button, formatTime } from './StudioPrimitives';

export type TranscriptAction = 'add' | 'cut' | 'restore';
export interface TranscriptPanelProps {
  transcript: TranscriptDto;
  ranges: WordRange[];
  removedWords?: number[];
  activeWordIndex?: number | null;
  picker?: boolean;
  onToggleWord?: (wordIndex: number) => void;
  onRangeAction?: (action: TranscriptAction, range: WordRange) => void;
  onSetBoundary?: (rangeIndex: number, side: 'start' | 'end', wordIndex: number) => void;
  onSeekWord?: (wordIndex: number) => void;
  onCorrectWord?: (wordIndex: number, text: string) => void;
  correctingWordIndex?: number | null;
  onSelectionChange?: (range: WordRange | null) => void;
}
export interface TranscriptParagraphProps {
  words: TranscriptWordDto[];
  kept: ReadonlySet<number>;
  removed: ReadonlySet<number>;
  boundaries: ReadonlyMap<number, Array<{ rangeIndex: number; side: 'start' | 'end' }>>;
  active: number | null;
  selected: WordRange | null;
  cursor: number;
  picker: boolean;
  editing: number | null;
  correcting: number | null;
  canCorrect: boolean;
  onCorrect: (wordIndex: number, text: string) => void;
  onCancelCorrection: (wordIndex: number) => void;
}
const TranscriptParagraph = memo(function TranscriptParagraph({
  words,
  kept,
  removed,
  boundaries,
  active,
  selected,
  cursor,
  picker,
  editing,
  correcting,
  canCorrect,
  onCorrect,
  onCancelCorrection,
}: TranscriptParagraphProps) {
  return (
    <div className="transcript-paragraph">
      <span className="sentence-time">{formatTime(words[0]?.start ?? 0)}</span>
      <p lang="pt-BR">
        {words.map((word) => (
          <span key={word.i} className="word-wrap">
            {boundaries
              .get(word.i)
              ?.filter((boundary) => boundary.side === 'start')
              .map((boundary) => (
                <button
                  type="button"
                  key={`s${boundary.rangeIndex}`}
                  className="range-handle range-handle--start"
                  data-boundary={boundary.rangeIndex}
                  data-side="start"
                  data-index={word.i}
                  aria-label={`Range ${boundary.rangeIndex + 1} start. Drag or use arrow keys.`}
                >
                  [
                </button>
              ))}
            {editing === word.i ? (
              <WordCorrectionEditor
                word={word}
                onSave={onCorrect}
                onCancel={onCancelCorrection}
              />
            ) : (
            <button
              type="button"
              tabIndex={cursor === word.i ? 0 : -1}
              data-word={word.i}
              aria-label={`${word.text}${removed.has(word.i) ? ', removed' : kept.has(word.i) ? ', kept' : ', outside short'}${correcting === word.i ? ', saving correction' : ''}`}
              aria-keyshortcuts={canCorrect ? 'F2' : undefined}
              aria-busy={correcting === word.i || undefined}
              title={canCorrect ? 'Hold or right-click to correct · F2' : undefined}
              aria-pressed={
                picker
                  ? Boolean(selected && word.i >= selected.startWord && word.i <= selected.endWord)
                  : kept.has(word.i) && !removed.has(word.i)
              }
              className={`transcript-word ${kept.has(word.i) ? 'word-kept' : 'word-outside'} ${removed.has(word.i) ? 'word-removed' : ''} ${active === word.i ? 'word-active' : ''} ${selected && word.i >= selected.startWord && word.i <= selected.endWord ? 'word-selected' : ''} ${correcting === word.i ? 'word-correcting' : ''}`}
            >
              {word.text}
              {correcting === word.i && (
                <span className="word-saving" aria-hidden="true">
                  <span className="spinner" /> Saving
                </span>
              )}
            </button>
            )}
            {boundaries
              .get(word.i)
              ?.filter((boundary) => boundary.side === 'end')
              .map((boundary) => (
                <button
                  type="button"
                  key={`e${boundary.rangeIndex}`}
                  className="range-handle range-handle--end"
                  data-boundary={boundary.rangeIndex}
                  data-side="end"
                  data-index={word.i}
                  aria-label={`Range ${boundary.rangeIndex + 1} end. Drag or use arrow keys.`}
                >
                  ]
                </button>
              ))}{' '}
          </span>
        ))}
      </p>
    </div>
  );
});
interface WordCorrectionEditorProps {
  word: TranscriptWordDto;
  onSave: (wordIndex: number, text: string) => void;
  onCancel: (wordIndex: number) => void;
}
function WordCorrectionEditor({ word, onSave, onCancel }: WordCorrectionEditorProps) {
  const [draft, setDraft] = useState(word.text);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const text = draft.trim();
  const valid = text.length >= 1 && text.length <= 40 && !/[\r\n\t\u2028\u2029]/u.test(draft);
  const dirty = draft !== word.text;
  const blocker = useBlocker(dirty);
  const error = !text.length
    ? 'Enter a word to save.'
    : text.length > 40
      ? 'Use 40 characters or fewer.'
      : !valid
        ? 'Use one line, without tabs.'
        : null;
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    input.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const viewport = window.visualViewport;
    const reveal = () => input.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    viewport?.addEventListener('resize', reveal);
    return () => viewport?.removeEventListener('resize', reveal);
  }, []);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard this word correction?')) blocker.proceed();
    else {
      blocker.reset();
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    }
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function save() {
    if (valid) onSave(word.i, text);
  }
  return (
    <span
      className="word-correction"
      role="group"
      aria-label={`Correct “${word.text}”`}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel(word.i);
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          save();
        }
      }}
    >
      <span className="word-correction-heading">
        <label htmlFor={id}>Correct word</label>
        <span className={text.length > 40 ? 'word-correction-count is-invalid' : 'word-correction-count'}>
          {text.length}/40
        </span>
      </span>
      <input
        ref={input}
        id={id}
        type="text"
        value={draft}
        lang="pt-BR"
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={!valid}
        aria-describedby={`${id}-scope ${id}-help`}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData('text');
          if (!/[\r\n\t\u2028\u2029]/u.test(pasted)) return;
          event.preventDefault();
          const field = event.currentTarget;
          setDraft(
            draft.slice(0, field.selectionStart ?? 0) +
              pasted +
              draft.slice(field.selectionEnd ?? draft.length),
          );
        }}
      />
      <span className="word-correction-scope" id={`${id}-scope`}>
        Updates captions in every short from this video.
      </span>
      <span className="word-correction-footer">
        <span
          id={`${id}-help`}
          className={error ? 'word-correction-error' : 'word-correction-shortcuts'}
          aria-live="polite"
        >
          {error ?? <><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</>}
        </span>
        <span className="word-correction-actions">
          <Button variant="ghost" onClick={() => onCancel(word.i)}>Cancel</Button>
          <Button variant="primary" icon="check" disabled={!valid} onClick={save}>Save</Button>
        </span>
      </span>
    </span>
  );
}
const noRemovedWords: number[] = [];
interface Gesture {
  start: number;
  end: number;
  dragged: boolean;
  seek: boolean;
  boundary?: { rangeIndex: number; side: 'start' | 'end' };
  pointerX?: number;
  pointerY?: number;
}
export function TranscriptPanel({
  transcript,
  ranges,
  removedWords = noRemovedWords,
  activeWordIndex = null,
  picker = false,
  onToggleWord,
  onRangeAction,
  onSetBoundary,
  onSeekWord,
  onCorrectWord,
  correctingWordIndex = null,
  onSelectionChange,
}: TranscriptPanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const anchor = useRef<number | null>(null);
  const [selection, setSelection] = useState<WordRange | null>(null);
  const [cursor, setCursor] = useState(ranges[0]?.startWord ?? transcript.words[0]?.i ?? 0);
  const [editingWordIndex, setEditingWordIndex] = useState<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusWord = useCallback((index: number) => {
    root.current?.querySelector<HTMLElement>(`[data-word="${index}"]`)?.focus({ preventScroll: true });
  }, []);
  const cancelCorrection = useCallback((index: number) => {
    setEditingWordIndex(null);
    requestAnimationFrame(() => focusWord(index));
  }, [focusWord]);
  const saveCorrection = useCallback((index: number, text: string) => {
    onCorrectWord?.(index, text);
    cancelCorrection(index);
  }, [onCorrectWord, cancelCorrection]);
  const clearHold = useCallback(() => {
    clearTimeout(holdTimer.current ?? undefined);
    holdTimer.current = null;
  }, []);
  useEffect(() => clearHold, [clearHold]);
  function beginCorrection(index: number) {
    if (picker || !onCorrectWord || correctingWordIndex !== null) return;
    if (editingWordIndex !== null) {
      root.current?.querySelector<HTMLInputElement>('.word-correction input')?.focus();
      return;
    }
    gesture.current = null;
    setCursor(index);
    setEditingWordIndex(index);
  }
  const wordMap = useMemo(
    () => new Map(transcript.words.map((word) => [word.i, word])),
    [transcript],
  );
  const kept = useMemo(() => {
    const set = new Set<number>();
    for (const word of transcript.words)
      if (ranges.some((range) => word.i >= range.startWord && word.i <= range.endWord))
        set.add(word.i);
    return set;
  }, [ranges, transcript]);
  const removed = useMemo(() => new Set(removedWords), [removedWords]);
  const boundaries = useMemo(() => {
    const map = new Map<number, Array<{ rangeIndex: number; side: 'start' | 'end' }>>();
    if (!picker)
      ranges.forEach((range, rangeIndex) => {
        for (const side of ['start', 'end'] as const) {
          const index = side === 'start' ? range.startWord : range.endWord;
          map.set(index, [...(map.get(index) ?? []), { rangeIndex, side }]);
        }
      });
    return map;
  }, [ranges, picker]);
  const paragraphs = useMemo(
    () =>
      transcript.sentences.length
        ? transcript.sentences
            .map((sentence) => transcript.words.slice(sentence.startWord, sentence.endWord + 1))
            .filter((words) => words.length > 0)
        : Array.from({ length: Math.ceil(transcript.words.length / 45) }, (_, index) =>
            transcript.words.slice(index * 45, index * 45 + 45),
          ),
    [transcript],
  );
  const initialWord = ranges[0]?.startWord;
  useEffect(() => {
    const container = root.current;
    if (!container || transcript.words.length === 0) return;
    const word =
      initialWord !== undefined
        ? container?.querySelector<HTMLElement>(`[data-word="${initialWord}"]`)
        : null;
    if (container && word)
      container.scrollTop +=
        word.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        container.clientHeight / 3;
  }, [initialWord, transcript]);
  useEffect(() => {
    const container = root.current;
    const word =
      activeWordIndex !== null
        ? container?.querySelector<HTMLElement>(`[data-word="${activeWordIndex}"]`)
        : null;
    if (!container || !word) return;
    const bounds = container.getBoundingClientRect();
    const wordBounds = word.getBoundingClientRect();
    if (wordBounds.top < bounds.top) container.scrollTop -= bounds.top - wordBounds.top + 20;
    else if (wordBounds.bottom > bounds.bottom)
      container.scrollTop += wordBounds.bottom - bounds.bottom + 20;
  }, [activeWordIndex]);
  function select(start: number, end: number) {
    const range = { startWord: Math.min(start, end), endWord: Math.max(start, end) };
    setSelection(range);
    onSelectionChange?.(range);
  }
  function clear() {
    setSelection(null);
    onSelectionChange?.(null);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    clearHold();
    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest<HTMLElement>('[data-boundary]');
    const word = target?.closest<HTMLElement>('[data-word]');
    if (handle) {
      event.preventDefault();
      gesture.current = {
        start: Number(handle.dataset.index),
        end: Number(handle.dataset.index),
        dragged: false,
        seek: false,
        boundary: {
          rangeIndex: Number(handle.dataset.boundary),
          side: handle.dataset.side === 'start' ? 'start' : 'end',
        },
      };
    } else if (word) {
      const index = Number(word.dataset.word);
      setCursor(index);
      gesture.current = {
        start: event.shiftKey && anchor.current !== null ? anchor.current : index,
        end: index,
        dragged: event.shiftKey,
        seek: event.altKey,
        pointerX: event.clientX,
        pointerY: event.clientY,
      };
      if (!event.shiftKey) anchor.current = index;
      if (event.shiftKey) select(gesture.current.start, index);
      if (event.pointerType === 'touch' && !event.altKey && !event.shiftKey && !picker && onCorrectWord) {
        const pointerId = event.pointerId;
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          beginCorrection(index);
          gesture.current = null;
          if (root.current?.hasPointerCapture(pointerId)) root.current.releasePointerCapture(pointerId);
        }, 450);
      }
    } else return;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    if (
      current.pointerX !== undefined &&
      current.pointerY !== undefined &&
      Math.hypot(event.clientX - current.pointerX, event.clientY - current.pointerY) > 8
    ) clearHold();
    const element = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-word]');
    if (!element) return;
    const index = Number(element.dataset.word);
    if (index !== current.end) {
      current.end = index;
      clearHold();
      current.dragged = true;
      if (!current.boundary && !current.seek) select(current.start, index);
    }
  }
  function pointerUp() {
    clearHold();
    const current = gesture.current;
    gesture.current = null;
    if (!current) return;
    if (current.boundary)
      onSetBoundary?.(current.boundary.rangeIndex, current.boundary.side, current.end);
    else if (current.seek) onSeekWord?.(current.end);
    else if (!current.dragged) {
      if (picker) select(current.start, current.end);
      else {
        clear();
        if (kept.has(current.end)) onToggleWord?.(current.end);
      }
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.dataset.boundary !== undefined &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(
          transcript.words.length - 1,
          Number(target.dataset.index) + (event.key === 'ArrowLeft' ? -1 : 1),
        ),
      );
      onSetBoundary?.(
        Number(target.dataset.boundary),
        target.dataset.side === 'start' ? 'start' : 'end',
        next,
      );
      return;
    }
    if (target?.dataset.word === undefined) return;
    const index = Number(target.dataset.word);
    if (event.key === 'F2' && !event.altKey && !event.shiftKey && !picker && onCorrectWord) {
      event.preventDefault();
      event.stopPropagation();
      beginCorrection(index);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(transcript.words.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)),
      );
      if (event.shiftKey) {
        anchor.current ??= index;
        select(anchor.current, next);
      } else anchor.current = next;
      setCursor(next);
      root.current?.querySelector<HTMLElement>(`[data-word="${next}"]`)?.focus();
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey) onSeekWord?.(index);
      else if (picker || event.shiftKey) select(anchor.current ?? index, index);
      else if (kept.has(index)) onToggleWord?.(index);
    }
    if (event.key === 'Escape') clear();
  }
  const selectedDuration = selection
    ? (wordMap.get(selection.endWord)?.end ?? 0) - (wordMap.get(selection.startWord)?.start ?? 0)
    : 0;
  return (
    <div className={`transcript-panel ${picker ? 'transcript-picker' : ''}`}>
      <span className="transcript-announcement" role="status">
        {correctingWordIndex !== null ? 'Saving word correction…' : ''}
      </span>
      <div className="transcript-help">
        {picker ? (
          'Click a start word, then Shift-click an end word.'
        ) : (
          <>
            <span>Click to cut · Drag to select · <kbd>Alt</kbd> + click to seek</span>
            {onCorrectWord && (
              <span className="transcript-correction-hint">
                Hold or right-click a word to correct · <kbd>F2</kbd> from the word cursor
              </span>
            )}
          </>
        )}
      </div>
      {selection && (
        <div className="selection-bar" role="region" aria-label="Transcript selection">
          <span>
            <strong>{selection.endWord - selection.startWord + 1} words</strong>
            <span className="muted"> · {formatTime(selectedDuration)}</span>
          </span>
          {!picker && (
            <div className="selection-actions">
              {(['add', 'cut', 'restore'] as const).map((action) => (
                <Button
                  key={action}
                  variant={action === 'add' ? 'primary' : 'secondary'}
                  onClick={() => {
                    onRangeAction?.(action, selection);
                    clear();
                  }}
                >
                  {action === 'add'
                    ? 'Add to short'
                    : action === 'cut'
                      ? 'Cut from short'
                      : 'Restore'}
                </Button>
              ))}
            </div>
          )}
          <Button variant="ghost" icon="close" aria-label="Clear selection" onClick={clear} />
        </div>
      )}
      <div
        ref={root}
        className="transcript-scroll"
        role="region"
        aria-label={picker ? 'Transcript range selection' : 'Transcript words'}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onContextMenu={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          const word = target?.closest<HTMLElement>('[data-word]');
          if (!word || picker || !onCorrectWord || event.altKey || event.shiftKey) return;
          event.preventDefault();
          clearHold();
          gesture.current = null;
          beginCorrection(Number(word.dataset.word));
        }}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          clearHold();
          gesture.current = null;
        }}
        onKeyDown={keyDown}
      >
        {paragraphs.map((words, index) => {
          const first = words[0]?.i ?? 0;
          const last = words[words.length - 1]?.i ?? 0;
          return (
            <TranscriptParagraph
              key={index}
              words={words}
              kept={kept}
              removed={removed}
              boundaries={boundaries}
              active={
                activeWordIndex !== null && activeWordIndex >= first && activeWordIndex <= last
                  ? activeWordIndex
                  : null
              }
              selected={
                selection && selection.endWord >= first && selection.startWord <= last
                  ? selection
                  : null
              }
              cursor={cursor >= first && cursor <= last ? cursor : -1}
              picker={picker}
              editing={
                editingWordIndex !== null && editingWordIndex >= first && editingWordIndex <= last
                  ? editingWordIndex
                  : null
              }
              correcting={
                !picker && correctingWordIndex !== null && correctingWordIndex >= first && correctingWordIndex <= last
                  ? correctingWordIndex
                  : null
              }
              canCorrect={!picker && Boolean(onCorrectWord)}
              onCorrect={saveCorrection}
              onCancelCorrection={cancelCorrection}
            />
          );
        })}
        {transcript.words.length === 0 && (
          <p className="muted transcript-empty">The transcript is not available yet.</p>
        )}
      </div>
    </div>
  );
}
