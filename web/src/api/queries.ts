import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutopilotStatusDto,
  ChooseSpeakerRequest,
  CorrectWordRequest,
  CreateJobRequest,
  CreateManualShortRequest,
  JobDetailDto,
  ReviseRequest,
  SaveEditRequest,
  SetShortStatusRequest,
  ShortDetailDto,
  TranscriptDto,
  UpdatePublishCopyRequest,
  UpdateShortMetaRequest,
  PublishRequest,
} from '@api';
import type { CropAnalysisStatus, ExportStatus, JobStatus, PublicationStatus } from '@domain/model';
import * as api from './client';

export const queryKeys = {
  creators: ['creators'] as const,
  jobs: ['jobs'] as const,
  job: (jobId: string) => ['job', jobId] as const,
  transcript: (jobId: string) => ['transcript', jobId] as const,
  short: (shortId: string) => ['short', shortId] as const,
  schedule: ['schedule'] as const,
  autopilot: ['autopilot'] as const,
};

const POLL_INTERVAL_MS = 2000;
const AUTOPILOT_POLL_INTERVAL_MS = 5000;
const AUTOPILOT_IDLE_POLL_INTERVAL_MS = 30000;

const ACTIVE_JOB_STATUSES: Partial<Record<JobStatus, true>> = {
  queued: true,
  downloading: true,
  transcribing: true,
  planning: true,
};
const ACTIVE_CROP_STATUSES: Partial<Record<CropAnalysisStatus, true>> = {
  queued: true,
  running: true,
};
const ACTIVE_EXPORT_STATUSES: Partial<Record<ExportStatus, true>> = {
  queued: true,
  rendering: true,
};
const ACTIVE_PUBLICATION_STATUSES: Partial<Record<PublicationStatus, true>> = {
  queued: true,
  publishing: true,
  submitted: true,
  deferred: true,
};

function shortIsActive(short: {
  cropAnalysis: CropAnalysisStatus;
  latestExport: { status: ExportStatus } | null;
}): boolean {
  return (
    ACTIVE_CROP_STATUSES[short.cropAnalysis] === true ||
    (short.latestExport !== null && ACTIVE_EXPORT_STATUSES[short.latestExport.status] === true)
  );
}

export function useCreatorsQuery() {
  return useQuery({
    queryKey: queryKeys.creators,
    queryFn: api.listCreators,
  });
}

export function useJobsQuery() {
  return useQuery({
    queryKey: queryKeys.jobs,
    queryFn: api.listJobs,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs !== undefined && jobs.some((job) => ACTIVE_JOB_STATUSES[job.status] === true)
        ? POLL_INTERVAL_MS
        : false;
    },
  });
}

export function useJobQuery(jobId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => api.getJob(jobId),
    enabled: options.enabled ?? true,
    refetchInterval: (query) => {
      const job = query.state.data;
      if (job === undefined) return false;
      const shortActive = job.shorts.some(shortIsActive);
      return ACTIVE_JOB_STATUSES[job.status] === true || shortActive ? POLL_INTERVAL_MS : false;
    },
  });
}

export function useTranscriptQuery(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.transcript(jobId),
    queryFn: () => api.getTranscript(jobId),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useShortQuery(shortId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.short(shortId),
    queryFn: () => api.getShort(shortId),
    enabled: options.enabled ?? true,
    refetchInterval: (query) => {
      const detail = query.state.data;
      if (detail === undefined) return false;
      const publicationActive = detail.publications.some(
        (publication) => ACTIVE_PUBLICATION_STATUSES[publication.status] === true,
      );
      const exportActive = detail.exports.some(
        (exportRecord) => ACTIVE_EXPORT_STATUSES[exportRecord.status] === true,
      );
      const cropActive = ACTIVE_CROP_STATUSES[detail.short.cropAnalysis] === true;
      return cropActive || exportActive || publicationActive ? POLL_INTERVAL_MS : false;
    },
  });
}

function useShortDetailMutation<TVariables>(
  shortId: string,
  mutationFn: (variables: TVariables) => Promise<ShortDetailDto>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.short(shortId), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.short(shortId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(detail.job.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export function useSaveEditMutation(shortId: string) {
  return useShortDetailMutation<SaveEditRequest>(shortId, (request) =>
    api.saveEdit(shortId, request),
  );
}

export function useReviseMutation(shortId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ReviseRequest) => api.revise(shortId, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.short(shortId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export function useUpdateShortMetaMutation(shortId: string) {
  return useShortDetailMutation<UpdateShortMetaRequest>(shortId, (request) =>
    api.updateShortMeta(shortId, request),
  );
}

export function useSetShortStatusMutation(shortId: string) {
  return useShortDetailMutation<{ shortId: string; status: SetShortStatusRequest['status'] }>(
    shortId,
    (input) => api.setShortStatus(shortId, { status: input.status }),
  );
}

export function useAnalyzeCropsMutation(shortId: string) {
  return useShortDetailMutation<void>(shortId, () => api.analyzeCrops(shortId));
}

export function useExportShortMutation(shortId: string) {
  return useShortDetailMutation<void>(shortId, () => api.exportShort(shortId));
}

export function useGeneratePublishCopyMutation(shortId: string) {
  return useShortDetailMutation<void>(shortId, () => api.generatePublishCopy(shortId));
}

export function useUpdatePublishCopyMutation(shortId: string) {
  return useShortDetailMutation<UpdatePublishCopyRequest>(shortId, (request) =>
    api.updatePublishCopy(shortId, request),
  );
}

export function useSuggestHooksMutation(shortId: string) {
  return useMutation({
    mutationFn: () => api.suggestHooks(shortId),
  });
}

export function usePublishMutation(shortId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { exportId: string; request: PublishRequest }) =>
      api.publish(input.exportId, input.request),
    onSuccess: (publications) => {
      queryClient.setQueryData<ShortDetailDto>(queryKeys.short(shortId), (detail) => {
        if (detail === undefined) {
          return detail;
        }
        const returnedIds = new Set(publications.map((publication) => publication.id));
        return {
          ...detail,
          publications: [...publications, ...detail.publications.filter((publication) => !returnedIds.has(publication.id))],
        };
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.short(shortId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedule });
    },
  });
}

export function useScheduleQuery() {
  return useQuery({
    queryKey: queryKeys.schedule,
    queryFn: api.listScheduledPosts,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}

export function useCancelScheduledPostMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { publicationId: string; shortId: string }) =>
      api.cancelPublication(input.publicationId),
    onSuccess: (detail, input) => {
      queryClient.setQueryData(queryKeys.short(input.shortId), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.short(input.shortId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedule });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(detail.job.id) });
    },
  });
}

export function useAutopilotQuery() {
  return useQuery({
    queryKey: queryKeys.autopilot,
    queryFn: api.listAutopilotStatuses,
    refetchInterval: (query) => {
      const statuses = query.state.data;
      const active =
        statuses !== undefined &&
        statuses.some((status) => status.enabled || status.checkRequested);
      return active ? AUTOPILOT_POLL_INTERVAL_MS : AUTOPILOT_IDLE_POLL_INTERVAL_MS;
    },
  });
}

export function useSetAutopilotMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { creatorId: string; enabled: boolean }) =>
      api.setAutopilot(input.creatorId, { enabled: input.enabled }),
    onSuccess: (status, input) => {
      queryClient.setQueryData<AutopilotStatusDto[]>(queryKeys.autopilot, (statuses) =>
        statuses?.map((existing) =>
          existing.creatorId === input.creatorId ? status : existing,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedule });
    },
  });
}

export function useCheckAutopilotNowMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { creatorId: string }) => api.checkAutopilotNow(input.creatorId),
    onSuccess: (status, input) => {
      queryClient.setQueryData<AutopilotStatusDto[]>(queryKeys.autopilot, (statuses) =>
        statuses?.map((existing) =>
          existing.creatorId === input.creatorId ? status : existing,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedule });
    },
  });
}

export function useCreateJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateJobRequest) => api.createJob(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

function useJobDetailMutation<TVariables>(
  jobId: string,
  mutationFn: (variables: TVariables) => Promise<JobDetailDto>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (job) => {
      queryClient.setQueryData(queryKeys.job(jobId), job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export function useRetryJobMutation(jobId: string) {
  return useJobDetailMutation<void>(jobId, () => api.retryJob(jobId));
}

export function useChooseSpeakerMutation(jobId: string) {
  return useJobDetailMutation<ChooseSpeakerRequest>(jobId, (request) =>
    api.chooseSpeaker(jobId, request),
  );
}

export function useReplanMutation(jobId: string) {
  return useJobDetailMutation<void>(jobId, () => api.replan(jobId));
}

export function useCreateManualShortMutation(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateManualShortRequest) => api.createManualShort(jobId, request),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.short(detail.short.id), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export function useCorrectWordMutation(jobId: string, shortId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { wordIndex: number; text: string }) =>
      api.correctWord(jobId, input.wordIndex, { text: input.text } satisfies CorrectWordRequest),
    onSuccess: (dto) => {
      queryClient.setQueryData(queryKeys.transcript(jobId), dto);
      void queryClient.invalidateQueries({ queryKey: queryKeys.short(shortId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) });
    },
  });
}
