import {
  useCancelScheduledPostMutation,
  useCreateJobMutation,
  useCreatorsQuery,
  useJobsQuery,
  useScheduleQuery,
} from '../api/queries';
import { InboxView } from '../views/InboxView';

export function InboxPage() {
  const creatorsQuery = useCreatorsQuery();
  const jobsQuery = useJobsQuery();
  const scheduleQuery = useScheduleQuery();
  const createJobMutation = useCreateJobMutation();
  const cancelPublicationMutation = useCancelScheduledPostMutation();

  const error =
    [creatorsQuery.error?.message, jobsQuery.error?.message, createJobMutation.error?.message].find(
      (message) => message !== undefined,
    ) ?? null;

  return (
    <InboxView
      creators={creatorsQuery.data ?? []}
      jobs={jobsQuery.data ?? []}
      upcomingPosts={scheduleQuery.data ?? []}
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
