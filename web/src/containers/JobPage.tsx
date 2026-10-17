import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { WordRange } from '@domain/edit';
import { ApiRequestError, errorMessage } from '../api/client';
import {
  queryKeys,
  useChooseSpeakerMutation,
  useCreateManualShortMutation,
  useJobQuery,
  useReplanMutation,
  useRetryJobMutation,
  useSetShortStatusMutation,
  useTranscriptQuery,
} from '../api/queries';
import { JobView } from '../views/JobView';
import { LoadErrorState, NotFoundState } from './RouteStates';

export function JobPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const jobQuery = useJobQuery(jobId ?? '', { enabled: jobId !== undefined });
  const job = jobQuery.data;
  const transcriptQuery = useTranscriptQuery(jobId ?? '', job?.status === 'ready');

  const retryMutation = useRetryJobMutation(jobId ?? '');
  const chooseSpeakerMutation = useChooseSpeakerMutation(jobId ?? '');
  const replanMutation = useReplanMutation(jobId ?? '');
  const createShortMutation = useCreateManualShortMutation(jobId ?? '');
  const statusMutation = useSetShortStatusMutation(jobId ?? '');

  const runAction = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, []);

  if (jobId === undefined) return <NotFoundState message="This source video does not exist." />;
  if (jobQuery.isPending) return null;
  if (job === undefined) {
    return jobQuery.error instanceof ApiRequestError && jobQuery.error.status === 404 ? (
      <NotFoundState message="This source video does not exist or was removed." />
    ) : (
      <LoadErrorState
        message={
          jobQuery.error === null
            ? 'The studio server could not be reached.'
            : jobQuery.error.message
        }
      />
    );
  }

  const transcriptError =
    transcriptQuery.isError && transcriptQuery.error !== null
      ? transcriptQuery.error.message
      : null;
  const pollError =
    jobQuery.isError && jobQuery.error !== null ? jobQuery.error.message : null;

  return (
    <JobView
      job={job}
      transcript={transcriptQuery.data ?? null}
      error={actionError ?? transcriptError ?? pollError}
      retryPending={retryMutation.isPending}
      speakerPending={chooseSpeakerMutation.isPending}
      replanPending={replanMutation.isPending}
      createPending={createShortMutation.isPending}
      statusPendingId={
        statusMutation.isPending ? (statusMutation.variables?.shortId ?? null) : null
      }
      onRetry={() => void runAction(() => retryMutation.mutateAsync(undefined))}
      onChooseSpeaker={(speakerId) =>
        void runAction(() => chooseSpeakerMutation.mutateAsync({ speakerId }))
      }
      onReplan={() => void runAction(() => replanMutation.mutateAsync(undefined))}
      onCreateShort={(range: WordRange) => {
        void runAction(async () => {
          const detail = await createShortMutation.mutateAsync({ range });
          queryClient.setQueryData(queryKeys.short(detail.short.id), detail);
          await navigate(`/shorts/${detail.short.id}`);
        });
      }}
      onSetShortStatus={(shortId, status) =>
        void runAction(() => statusMutation.mutateAsync({ shortId, status }))
      }
    />
  );
}
