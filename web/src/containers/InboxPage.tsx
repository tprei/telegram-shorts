import { useCreateJobMutation, useCreatorsQuery, useJobsQuery } from '../api/queries';
import { InboxView } from '../views/InboxView';

export function InboxPage() {
  const creatorsQuery = useCreatorsQuery();
  const jobsQuery = useJobsQuery();
  const createJobMutation = useCreateJobMutation();

  const error =
    [creatorsQuery.error?.message, jobsQuery.error?.message, createJobMutation.error?.message].find(
      (message) => message !== undefined,
    ) ?? null;

  return (
    <InboxView
      creators={creatorsQuery.data ?? []}
      jobs={jobsQuery.data ?? []}
      loading={creatorsQuery.isPending || jobsQuery.isPending}
      pending={createJobMutation.isPending}
      error={error}
      onAddVideo={(request) => createJobMutation.mutate(request)}
    />
  );
}
