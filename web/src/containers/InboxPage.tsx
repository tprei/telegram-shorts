import {
  useAutopilotQuery,
  useCancelScheduledPostMutation,
  useCheckAutopilotNowMutation,
  useCreateJobMutation,
  useCreatorsQuery,
  useJobsQuery,
  useScheduleQuery,
  useSetAutopilotMutation,
} from '../api/queries';
import { InboxView } from '../views/InboxView';

export function InboxPage() {
  const creatorsQuery = useCreatorsQuery();
  const jobsQuery = useJobsQuery();
  const scheduleQuery = useScheduleQuery();
  const createJobMutation = useCreateJobMutation();
  const cancelPublicationMutation = useCancelScheduledPostMutation();
  const autopilotQuery = useAutopilotQuery();
  const setAutopilotMutation = useSetAutopilotMutation();
  const checkAutopilotMutation = useCheckAutopilotNowMutation();

  const error =
    [creatorsQuery.error?.message, jobsQuery.error?.message, createJobMutation.error?.message].find(
      (message) => message !== undefined,
    ) ?? null;

  const autopilotError =
    [
      autopilotQuery.error?.message,
      setAutopilotMutation.error?.message,
      checkAutopilotMutation.error?.message,
    ].find((message) => message !== undefined) ?? null;

  const pendingAutopilotCreatorIds = [
    ...(setAutopilotMutation.isPending && setAutopilotMutation.variables
      ? [setAutopilotMutation.variables.creatorId]
      : []),
    ...(checkAutopilotMutation.isPending && checkAutopilotMutation.variables
      ? [checkAutopilotMutation.variables.creatorId]
      : []),
  ];

  return (
    <InboxView
      creators={creatorsQuery.data ?? []}
      jobs={jobsQuery.data ?? []}
      upcomingPosts={scheduleQuery.data ?? []}
      autopilotStatuses={autopilotQuery.data ?? []}
      onToggleAutopilot={(creatorId, enabled) => setAutopilotMutation.mutate({ creatorId, enabled })}
      onCheckAutopilotNow={(creatorId) => checkAutopilotMutation.mutate({ creatorId })}
      pendingAutopilotCreatorIds={pendingAutopilotCreatorIds}
      autopilotError={autopilotError}
      onCancelPublication={(publicationId, shortId) =>
        cancelPublicationMutation.mutate({ publicationId, shortId })
      }
      scheduleLoading={scheduleQuery.isPending}
      scheduleError={scheduleQuery.error?.message ?? null}
      cancellingPublicationIds={
        cancelPublicationMutation.isPending && cancelPublicationMutation.variables
          ? [cancelPublicationMutation.variables.publicationId]
          : []
      }
      cancelError={cancelPublicationMutation.error?.message ?? null}
      loading={creatorsQuery.isPending || jobsQuery.isPending}
      pending={createJobMutation.isPending}
      error={error}
      onAddVideo={(request) => createJobMutation.mutate(request)}
    />
  );
}
