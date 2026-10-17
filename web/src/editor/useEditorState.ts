import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveEditRequest, ShortDetailDto } from '@api';
import type { ShortEdit } from '@domain/edit';
import { ApiRequestError, errorMessage } from '../api/client';
import type { AutosaveState } from '../views/ShortEditorView';

const MAX_UNDO_STEPS = 100;
const COALESCE_WINDOW_MS = 300;
const AUTOSAVE_DELAY_MS = 400;
const FLUSH_SAVE_ATTEMPTS = 5;

type SaveOutcome = 'saved' | 'current' | 'conflict' | 'error';

function editsEqual(a: ShortEdit, b: ShortEdit): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface EditorStateInput {
  detail: ShortDetailDto;
  saveEdit: (request: SaveEditRequest) => Promise<ShortDetailDto>;
  refetchShort: () => Promise<unknown>;
  onSaveError?: (message: string) => void;
}

export function useEditorState(input: EditorStateInput) {
  const { detail } = input;
  const [edit, setEdit] = useState<ShortEdit>(detail.short.edit);
  const [baseRevision, setBaseRevision] = useState(detail.short.editRevision);
  const [status, setStatus] = useState<AutosaveState>('saved');
  const [stackSizes, setStackSizes] = useState({ undo: 0, redo: 0 });

  const editRef = useRef(edit);
  const baseRevisionRef = useRef(baseRevision);
  const statusRef = useRef(status);
  const undoRef = useRef<ShortEdit[]>([]);
  const redoRef = useRef<ShortEdit[]>([]);
  const lastChangeAtRef = useRef(0);
  const lastSentRef = useRef<ShortEdit | null>(detail.short.edit);
  const saveTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef<{
    request: SaveEditRequest;
    promise: Promise<SaveOutcome>;
  } | null>(null);
  const conflictAdoptionRef = useRef(false);

  const saveEditRef = useRef(input.saveEdit);
  const refetchShortRef = useRef(input.refetchShort);
  const onSaveErrorRef = useRef(input.onSaveError);
  const runSaveRef = useRef<() => Promise<SaveOutcome>>(async () => 'current');
  const adoptRef = useRef<(next: ShortEdit, revision: number, nextStatus: AutosaveState) => void>(
    () => {},
  );
  saveEditRef.current = input.saveEdit;
  refetchShortRef.current = input.refetchShort;
  onSaveErrorRef.current = input.onSaveError;

  const updateStatus = useCallback((next: AutosaveState) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const syncStackSizes = useCallback(() => {
    setStackSizes({ undo: undoRef.current.length, redo: redoRef.current.length });
  }, []);

  const pushUndo = useCallback((previous: ShortEdit) => {
    undoRef.current.push(previous);
    if (undoRef.current.length > MAX_UNDO_STEPS) undoRef.current.shift();
  }, []);

  const startSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void runSaveRef.current();
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const runSave = useCallback((): Promise<SaveOutcome> => {
    if (inFlightRef.current !== null) return inFlightRef.current.promise;
    const target = editRef.current;
    if (lastSentRef.current !== null && editsEqual(target, lastSentRef.current)) {
      if (statusRef.current === 'unsaved' || statusRef.current === 'saving')
        updateStatus(conflictAdoptionRef.current ? 'conflict' : 'saved');
      return Promise.resolve<SaveOutcome>('current');
    }
    const request: SaveEditRequest = { edit: target, baseRevision: baseRevisionRef.current };
    let resolveOutcome!: (outcome: Exclude<SaveOutcome, 'current'>) => void;
    const promise = new Promise<Exclude<SaveOutcome, 'current'>>((resolve) => {
      resolveOutcome = resolve;
    });
    inFlightRef.current = { request, promise };
    updateStatus('saving');
    void (async () => {
      let outcome: Exclude<SaveOutcome, 'current'> = 'error';
      try {
        const result = await saveEditRef.current(request);
        lastSentRef.current = target;
        baseRevisionRef.current = result.short.editRevision;
        setBaseRevision(result.short.editRevision);
        if (editsEqual(editRef.current, target)) {
          updateStatus('saved');
        } else {
          updateStatus('unsaved');
          startSaveTimer();
        }
        outcome = 'saved';
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          conflictAdoptionRef.current = true;
          redoRef.current = [];
          syncStackSizes();
          updateStatus('conflict');
          void refetchShortRef.current();
          outcome = 'conflict';
        } else {
          updateStatus('unsaved');
          onSaveErrorRef.current?.(errorMessage(error));
          outcome = 'error';
        }
      } finally {
        inFlightRef.current = null;
        resolveOutcome(outcome);
      }
    })();
    return promise;
  }, [startSaveTimer, syncStackSizes, updateStatus]);
  runSaveRef.current = runSave;

  const adoptServerState = useCallback(
    (next: ShortEdit, revision: number, nextStatus: AutosaveState) => {
      pushUndo(editRef.current);
      redoRef.current = [];
      syncStackSizes();
      editRef.current = next;
      setEdit(next);
      baseRevisionRef.current = revision;
      setBaseRevision(revision);
      lastSentRef.current = next;
      lastChangeAtRef.current = 0;
      conflictAdoptionRef.current = false;
      updateStatus(nextStatus);
    },
    [pushUndo, syncStackSizes, updateStatus],
  );
  adoptRef.current = adoptServerState;

  const changeEdit = useCallback(
    (next: ShortEdit) => {
      const now = Date.now();
      if (now - lastChangeAtRef.current > COALESCE_WINDOW_MS) pushUndo(editRef.current);
      lastChangeAtRef.current = now;
      redoRef.current = [];
      syncStackSizes();
      editRef.current = next;
      setEdit(next);
      updateStatus('unsaved');
      startSaveTimer();
    },
    [pushUndo, startSaveTimer, syncStackSizes, updateStatus],
  );

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (previous === undefined) return;
    redoRef.current.push(editRef.current);
    editRef.current = previous;
    setEdit(previous);
    lastChangeAtRef.current = 0;
    syncStackSizes();
    updateStatus('unsaved');
    startSaveTimer();
  }, [startSaveTimer, syncStackSizes, updateStatus]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (next === undefined) return;
    undoRef.current.push(editRef.current);
    editRef.current = next;
    setEdit(next);
    lastChangeAtRef.current = 0;
    syncStackSizes();
    updateStatus('unsaved');
    startSaveTimer();
  }, [startSaveTimer, syncStackSizes, updateStatus]);

  const applyServerEdit = useCallback(
    (next: ShortEdit, revision: number) => adoptServerState(next, revision, 'saved'),
    [adoptServerState],
  );

  const flushPendingSave = useCallback(async (): Promise<number> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    for (let attempt = 0; attempt < FLUSH_SAVE_ATTEMPTS; attempt += 1) {
      if (
        inFlightRef.current === null &&
        lastSentRef.current !== null &&
        editsEqual(editRef.current, lastSentRef.current)
      )
        return baseRevisionRef.current;
      const outcome = await runSave();
      if (outcome === 'conflict' || outcome === 'error') return baseRevisionRef.current;
    }
    return baseRevisionRef.current;
  }, [runSave]);

  useEffect(() => {
    const forced = conflictAdoptionRef.current;
    const serverRevision = detail.short.editRevision;
    if (!forced && serverRevision <= baseRevisionRef.current) return;
    if (!forced && (statusRef.current === 'unsaved' || inFlightRef.current !== null)) return;
    adoptRef.current(detail.short.edit, serverRevision, forced ? 'conflict' : 'saved');
  }, [detail]);

  useEffect(() => {
    if (status !== 'unsaved' && status !== 'saving') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [status]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (inFlightRef.current === null && statusRef.current === 'unsaved') void runSaveRef.current();
    },
    [],
  );

  return {
    edit,
    baseRevision,
    status,
    canUndo: stackSizes.undo > 0,
    canRedo: stackSizes.redo > 0,
    changeEdit,
    undo,
    redo,
    applyServerEdit,
    flushPendingSave,
  };
}
