import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { MEDIA_ROUTES } from '@api';
import type { HookSuggestionsDto, ShortDetailDto, TranscriptDto } from '@api';
import {
  addRange,
  removeCropKeyframe,
  setRangeBoundary,
  setWordsRemoved,
  upsertCropKeyframe,
} from '@domain/edit';
import type { ShortEdit, WordRange } from '@domain/edit';
import type { NormRect } from '@domain/layout';
import type { PublishCopy, ShortVideoPlatform, TranscriptWord } from '@domain/model';
import {
  activeCueAt,
  buildTimeline,
  outputToSource,
  sourceToOutput,
} from '@domain/timeline';
import type { Timeline } from '@domain/timeline';
import { ApiRequestError, errorMessage } from '../api/client';
import {
  queryKeys,
  useAnalyzeCropsMutation,
  useExportShortMutation,
  useGeneratePublishCopyMutation,
  usePublishMutation,
  useReviseMutation,
  useSaveEditMutation,
  useShortQuery,
  useSuggestHooksMutation,
  useTranscriptQuery,
  useUpdatePublishCopyMutation,
  useUpdateShortMetaMutation,
} from '../api/queries';
import { useEditorState } from '../editor/useEditorState';
import type { RevisionSummary } from '../components/EditorInspector';
import type { TranscriptAction } from '../components/TranscriptPanel';
import { usePreviewEngine } from '../preview/usePreviewEngine';
import { ShortEditorView } from '../views/ShortEditorView';
import { LoadErrorState, NotFoundState } from './RouteStates';

const FULL_FRAME: NormRect = { x: 0, y: 0, w: 1, h: 1 };
const META_SAVE_DELAY_MS = 600;

export function ShortEditorPage() {
  const { shortId } = useParams();
  const shortQuery = useShortQuery(shortId ?? '', { enabled: shortId !== undefined });
  const detail = shortQuery.data;
  const transcriptQuery = useTranscriptQuery(detail?.job.id ?? '', detail !== undefined);

  if (shortId === undefined) return <NotFoundState message="This short does not exist." />;
  if (shortQuery.isPending) return null;
  if (detail === undefined) {
    return shortQuery.error instanceof ApiRequestError && shortQuery.error.status === 404 ? (
      <NotFoundState message="This short does not exist or was removed." />
    ) : (
      <LoadErrorState
        message={
          shortQuery.error === null
            ? 'The studio server could not be reached.'
            : shortQuery.error.message
        }
      />
    );
  }
  const transcript = transcriptQuery.data;
  if (transcript === undefined) return null;

  return (
    <ShortEditorSurface
      key={detail.short.id}
      detail={detail}
      transcript={transcript}
      refetchShort={shortQuery.refetch}
    />
  );
}

interface ShortEditorSurfaceProps {
  detail: ShortDetailDto;
  transcript: TranscriptDto;
  refetchShort: () => Promise<unknown>;
}

function ShortEditorSurface({ detail, transcript, refetchShort }: ShortEditorSurfaceProps) {
  const queryClient = useQueryClient();
  const [toastError, setToastError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hookSuggestions, setHookSuggestions] = useState<HookSuggestionsDto | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [title, setTitle] = useState(detail.short.title);
  const [publishCopyDraft, setPublishCopyDraft] = useState<PublishCopy | null>(
    detail.short.publishCopy,
  );
  const [selectedPlatforms, setSelectedPlatforms] = useState<ShortVideoPlatform[]>(() =>
    detail.platforms
      .filter((platform) => platform.available)
      .map((platform) => platform.platform),
  );

  const showToast = useCallback((message: string) => setToastError(message), []);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      setActionError(null);
      try {
        await action();
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) void refetchShort();
        setActionError(errorMessage(error));
      }
    },
    [refetchShort],
  );

  const saveEditMutation = useSaveEditMutation(detail.short.id);
  const editor = useEditorState({
    detail,
    saveEdit: saveEditMutation.mutateAsync,
    refetchShort,
    onSaveError: showToast,
  });
  const { edit, changeEdit, undo, redo, applyServerEdit, flushPendingSave } = editor;

  const reviseMutation = useReviseMutation(detail.short.id);
  const suggestHooksMutation = useSuggestHooksMutation(detail.short.id);
  const updateShortMetaMutation = useUpdateShortMetaMutation(detail.short.id);
  const analyzeCropsMutation = useAnalyzeCropsMutation(detail.short.id);
  const exportShortMutation = useExportShortMutation(detail.short.id);
  const generateCopyMutation = useGeneratePublishCopyMutation(detail.short.id);
  const updatePublishCopyMutation = useUpdatePublishCopyMutation(detail.short.id);
  const publishMutation = usePublishMutation();

  const transcriptWords = useMemo<TranscriptWord[]>(
    () =>
      transcript.words.map((word) => ({
        id: String(word.i),
        text: word.text,
        startSeconds: word.start,
        endSeconds: word.end,
        speakerId: word.speakerId,
        confidence: null,
      })),
    [transcript],
  );

  const layout = detail.job.layout;
  const media = detail.job.media;
  const shortTitle = detail.short.title;
  const timeline = useMemo<Timeline>(
    () =>
      buildTimeline({
        edit,
        words: transcriptWords,
        layout,
        title: shortTitle,
        source: {
          width: media.width,
          height: media.height,
          durationSeconds: media.durationSeconds,
        },
      }),
    [edit, transcriptWords, layout, media, shortTitle],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preview = usePreviewEngine({
    canvasRef,
    options: {
      videoUrl: media.videoUrl,
      fontUrl: detail.job.fontUrl,
      fontFamily: layout.font.family,
      thumbnailUrl: detail.job.thumbnailUrl,
    },
    timeline,
    layout,
  });

  const activeWordIndex = useMemo(() => {
    const active = activeCueAt(timeline, preview.outputSeconds);
    if (active === null || active.activeWordIndex === null) return null;
    return active.cue.lines.flat()[active.activeWordIndex]?.wordIndex ?? null;
  }, [timeline, preview.outputSeconds]);

  const titleTimerRef = useRef<number | null>(null);
  const pendingTitleRef = useRef<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const pendingCopyRef = useRef<PublishCopy | null>(null);

  const flushTitle = useCallback(() => {
    if (titleTimerRef.current !== null) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    const value = pendingTitleRef.current;
    if (value === null || value.trim().length === 0) return;
    pendingTitleRef.current = null;
    void updateShortMetaMutation.mutateAsync({ title: value }).catch(showToast);
  }, [showToast, updateShortMetaMutation.mutateAsync]);

  const flushPublishCopy = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    const copy = pendingCopyRef.current;
    if (
      copy === null ||
      copy.line1.trim().length === 0 ||
      copy.line2.trim().length === 0 ||
      copy.hashtags.length === 0
    )
      return;
    pendingCopyRef.current = null;
    void updatePublishCopyMutation.mutateAsync({ copy }).catch(showToast);
  }, [showToast, updatePublishCopyMutation.mutateAsync]);

  const onTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      pendingTitleRef.current = next;
      if (titleTimerRef.current !== null) window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = window.setTimeout(flushTitle, META_SAVE_DELAY_MS);
    },
    [flushTitle],
  );

  const onPublishCopyChange = useCallback(
    (copy: PublishCopy) => {
      setPublishCopyDraft(copy);
      pendingCopyRef.current = copy;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(flushPublishCopy, META_SAVE_DELAY_MS);
    },
    [flushPublishCopy],
  );

  useEffect(
    () => () => {
      if (titleTimerRef.current !== null) {
        window.clearTimeout(titleTimerRef.current);
        titleTimerRef.current = null;
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
      void flushTitle();
      void flushPublishCopy();
    },
    [flushTitle, flushPublishCopy],
  );

  const applyEditOperation = useCallback(
    (operation: () => ShortEdit) => {
      try {
        changeEdit(operation());
      } catch (error) {
        showToast(errorMessage(error));
      }
    },
    [changeEdit, showToast],
  );

  const onToggleWord = useCallback(
    (wordIndex: number) =>
      applyEditOperation(() =>
        setWordsRemoved(
          edit,
          wordIndex,
          wordIndex,
          !edit.removedWords.includes(wordIndex),
          transcriptWords.length,
        ),
      ),
    [applyEditOperation, edit, transcriptWords.length],
  );

  const onRangeAction = useCallback(
    (action: TranscriptAction, range: WordRange) =>
      applyEditOperation(() => {
        if (action === 'add') return addRange(edit, range, transcriptWords.length);
        return setWordsRemoved(
          edit,
          range.startWord,
          range.endWord,
          action === 'cut',
          transcriptWords.length,
        );
      }),
    [applyEditOperation, edit, transcriptWords.length],
  );

  const onSetBoundary = useCallback(
    (rangeIndex: number, side: 'start' | 'end', wordIndex: number) =>
      applyEditOperation(() =>
        setRangeBoundary(edit, rangeIndex, side, wordIndex, transcriptWords.length),
      ),
    [applyEditOperation, edit, transcriptWords.length],
  );

  const onCropChange = useCallback(
    (index: number, focus: NormRect) =>
      applyEditOperation(() =>
        upsertCropKeyframe(edit, { ...edit.crops[index], focus, origin: 'manual' }),
      ),
    [applyEditOperation, edit],
  );

  const onDeleteCrop = useCallback(
    (index: number) =>
      applyEditOperation(() => removeCropKeyframe(edit, edit.crops[index].sourceSeconds)),
    [applyEditOperation, edit],
  );

  const onAddCrop = useCallback(() => {
    applyEditOperation(() => {
      const { sourceSeconds } = outputToSource(timeline, preview.outputSeconds);
      const activeCrop = [...edit.crops]
        .reverse()
        .find((crop) => crop.sourceSeconds <= sourceSeconds);
      const contentPanel = layout.panels.find((panel) => panel.role === 'content');
      const focus: NormRect = activeCrop?.focus ?? contentPanel?.sourceRect ?? FULL_FRAME;
      return upsertCropKeyframe(edit, { sourceSeconds, focus, origin: 'manual' });
    });
  }, [applyEditOperation, edit, layout, preview.outputSeconds, timeline]);

  const onSeekWord = useCallback(
    (wordIndex: number) => {
      const word = transcriptWords[wordIndex];
      if (word === undefined) return;
      const outputSeconds = sourceToOutput(timeline, word.startSeconds);
      if (outputSeconds !== null) preview.seek(outputSeconds);
    },
    [preview, timeline, transcriptWords],
  );

  const onSuggestHooks = useCallback(() => {
    void runAction(async () => {
      const suggestions = await suggestHooksMutation.mutateAsync(undefined);
      setHookSuggestions(suggestions);
    });
  }, [runAction, suggestHooksMutation.mutateAsync]);

  const onRevise = useCallback(
    (message: string) => {
      void runAction(async () => {
        const baseRevision = await flushPendingSave();
        const result = await reviseMutation.mutateAsync({ message, baseRevision });
        setRevisions((previous) => [
          ...previous,
          { id: crypto.randomUUID(), summary: result.summary, warnings: result.warnings },
        ]);
        applyServerEdit(result.detail.short.edit, result.detail.short.editRevision);
        queryClient.setQueryData(queryKeys.short(detail.short.id), result.detail);
      });
    },
    [applyServerEdit, detail.short.id, flushPendingSave, queryClient, reviseMutation.mutateAsync, runAction],
  );

  const onAnalyzeCrops = useCallback(() => {
    void runAction(async () => {
      await flushPendingSave();
      await analyzeCropsMutation.mutateAsync(undefined);
    });
  }, [analyzeCropsMutation.mutateAsync, flushPendingSave, runAction]);

  const onExport = useCallback(() => {
    void runAction(async () => {
      await flushPendingSave();
      await exportShortMutation.mutateAsync(undefined);
    });
  }, [exportShortMutation.mutateAsync, flushPendingSave, runAction]);

  const onGenerateCopy = useCallback(() => {
    void runAction(async () => {
      const result = await generateCopyMutation.mutateAsync(undefined);
      setPublishCopyDraft(result.short.publishCopy);
    });
  }, [generateCopyMutation.mutateAsync, runAction]);

  const onPublish = useCallback(
    (force: boolean) => {
      void runAction(async () => {
        const readyExport = detail.exports.find(
          (exportRecord) => exportRecord.status === 'ready',
        );
        if (readyExport === undefined) throw new Error('Export the short before publishing.');
        await publishMutation.mutateAsync({
          exportId: readyExport.id,
          request: { platforms: selectedPlatforms, force },
        });
      });
    },
    [detail.exports, publishMutation.mutateAsync, runAction, selectedPlatforms],
  );

  const frameUrl = useCallback(
    (sourceSeconds: number, width: number) =>
      MEDIA_ROUTES.frame(detail.job.id, sourceSeconds, width),
    [detail.job.id],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return;
      if (event.key === ' ') {
        event.preventDefault();
        preview.toggle();
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview.toggle, redo, undo]);

  return (
    <ShortEditorView
      detail={detail}
      edit={edit}
      title={title}
      transcript={transcript}
      timeline={timeline}
      canvasRef={canvasRef}
      ready={preview.ready}
      playing={preview.playing}
      buffering={preview.buffering}
      outputSeconds={preview.outputSeconds}
      activeWordIndex={activeWordIndex}
      autosave={editor.status}
      canUndo={editor.canUndo}
      canRedo={editor.canRedo}
      previewError={preview.error}
      toastError={toastError}
      onDismissError={() => setToastError(null)}
      onUndo={undo}
      onRedo={redo}
      onTogglePlayback={preview.toggle}
      onSeek={preview.seek}
      onSeekWord={onSeekWord}
      onToggleWord={onToggleWord}
      onRangeAction={onRangeAction}
      onSetBoundary={onSetBoundary}
      frameUrl={frameUrl}
      hookSuggestions={hookSuggestions}
      hooksPending={suggestHooksMutation.isPending}
      revisePending={reviseMutation.isPending}
      revisions={revisions}
      exportPending={exportShortMutation.isPending}
      publishCopy={publishCopyDraft}
      copyPending={generateCopyMutation.isPending}
      selectedPlatforms={selectedPlatforms}
      publishPending={publishMutation.isPending}
      error={actionError}
      onTitleChange={onTitleChange}
      onEditChange={changeEdit}
      onSuggestHooks={onSuggestHooks}
      onCropChange={onCropChange}
      onAddCrop={onAddCrop}
      onDeleteCrop={onDeleteCrop}
      onAnalyzeCrops={onAnalyzeCrops}
      onRevise={onRevise}
      onExport={onExport}
      onGenerateCopy={onGenerateCopy}
      onPublishCopyChange={onPublishCopyChange}
      onSelectedPlatformsChange={setSelectedPlatforms}
      onPublish={onPublish}
    />
  );
}
