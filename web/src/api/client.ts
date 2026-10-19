import type {
  AutopilotStatusDto,
  ChooseSpeakerRequest,
  CorrectWordRequest,
  CreateJobRequest,
  CreateManualShortRequest,
  CreatorDto,
  HookSuggestionsDto,
  JobDetailDto,
  JobSummaryDto,
  PublicationDto,
  ReviseRequest,
  ReviseResultDto,
  SaveEditRequest,
  ScheduledPostDto,
  SetAutopilotRequest,
  SetDefaultCreatorRequest,
  SetShortStatusRequest,
  ShortDetailDto,
  TranscriptDto,
  UpdatePublishCopyRequest,
  UpdateShortMetaRequest,
  PublishRequest,
} from '@api';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'The studio server could not be reached.';
}

async function parseErrorBody(response: Response): Promise<{ code: string; message: string }> {
  const fallback = {
    code: 'error',
    message: `Request failed with status ${response.status}`,
  };
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return fallback;
    const record = body as { error?: unknown; code?: unknown };
    return {
      code: typeof record.code === 'string' && record.code.length > 0 ? record.code : fallback.code,
      message:
        typeof record.error === 'string' && record.error.length > 0
          ? record.error
          : fallback.message,
    };
  } catch {
    return fallback;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new ApiRequestError(response.status, code, message);
  }
  return (await response.json()) as T;
}

function jsonRequest<T>(method: string, path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listCreators(): Promise<CreatorDto[]> {
  return request<CreatorDto[]>('/api/creators');
}

export function setDefaultCreator(request: SetDefaultCreatorRequest): Promise<CreatorDto[]> {
  return jsonRequest<CreatorDto[]>('PUT', '/api/creators/default', request);
}

export function listJobs(): Promise<JobSummaryDto[]> {
  return request<JobSummaryDto[]>('/api/jobs');
}

export function createJob(request: CreateJobRequest): Promise<JobSummaryDto> {
  return jsonRequest<JobSummaryDto>('POST', '/api/jobs', request);
}

export function getJob(jobId: string): Promise<JobDetailDto> {
  return request<JobDetailDto>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function retryJob(jobId: string): Promise<JobDetailDto> {
  return jsonRequest<JobDetailDto>('POST', `/api/jobs/${encodeURIComponent(jobId)}/retry`, {});
}

export function getTranscript(jobId: string): Promise<TranscriptDto> {
  return request<TranscriptDto>(`/api/jobs/${encodeURIComponent(jobId)}/transcript`);
}

export function correctWord(
  jobId: string,
  wordIndex: number,
  request: CorrectWordRequest,
): Promise<TranscriptDto> {
  return jsonRequest<TranscriptDto>(
    'PUT',
    `/api/jobs/${encodeURIComponent(jobId)}/words/${wordIndex}`,
    request,
  );
}

export function chooseSpeaker(jobId: string, request: ChooseSpeakerRequest): Promise<JobDetailDto> {
  return jsonRequest<JobDetailDto>('POST', `/api/jobs/${encodeURIComponent(jobId)}/speaker`, request);
}

export function replan(jobId: string): Promise<JobDetailDto> {
  return jsonRequest<JobDetailDto>('POST', `/api/jobs/${encodeURIComponent(jobId)}/replan`, {});
}

export function analyzeScenes(jobId: string): Promise<JobDetailDto> {
  return jsonRequest<JobDetailDto>('POST', `/api/jobs/${encodeURIComponent(jobId)}/scenes/analyze`, {});
}

export function createManualShort(
  jobId: string,
  request: CreateManualShortRequest,
): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('POST', `/api/jobs/${encodeURIComponent(jobId)}/shorts`, request);
}

export function getShort(shortId: string): Promise<ShortDetailDto> {
  return request<ShortDetailDto>(`/api/shorts/${encodeURIComponent(shortId)}`);
}

export function saveEdit(shortId: string, request: SaveEditRequest): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('PUT', `/api/shorts/${encodeURIComponent(shortId)}/edit`, request);
}

export function revise(shortId: string, request: ReviseRequest): Promise<ReviseResultDto> {
  return jsonRequest<ReviseResultDto>('POST', `/api/shorts/${encodeURIComponent(shortId)}/revise`, request);
}

export function suggestHooks(shortId: string): Promise<HookSuggestionsDto> {
  return jsonRequest<HookSuggestionsDto>('POST', `/api/shorts/${encodeURIComponent(shortId)}/hooks`, {});
}

export function updateShortMeta(
  shortId: string,
  request: UpdateShortMetaRequest,
): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('PATCH', `/api/shorts/${encodeURIComponent(shortId)}`, request);
}

export function setShortStatus(
  shortId: string,
  request: SetShortStatusRequest,
): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('PUT', `/api/shorts/${encodeURIComponent(shortId)}/status`, request);
}

export function analyzeCrops(shortId: string): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('POST', `/api/shorts/${encodeURIComponent(shortId)}/crops/analyze`, {});
}

export function exportShort(shortId: string): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('POST', `/api/shorts/${encodeURIComponent(shortId)}/exports`, {});
}

export function generatePublishCopy(shortId: string): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('POST', `/api/shorts/${encodeURIComponent(shortId)}/copy/generate`, {});
}

export function updatePublishCopy(
  shortId: string,
  request: UpdatePublishCopyRequest,
): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('PUT', `/api/shorts/${encodeURIComponent(shortId)}/copy`, request);
}

export function publish(exportId: string, request: PublishRequest): Promise<PublicationDto[]> {
  return jsonRequest<PublicationDto[]>('POST', `/api/exports/${encodeURIComponent(exportId)}/publish`, request);
}

export function cancelPublication(publicationId: string): Promise<ShortDetailDto> {
  return jsonRequest<ShortDetailDto>('POST', `/api/publications/${encodeURIComponent(publicationId)}/cancel`, {});
}

export function listScheduledPosts(): Promise<ScheduledPostDto[]> {
  return request<ScheduledPostDto[]>('/api/schedule');
}

export function listAutopilotStatuses(): Promise<AutopilotStatusDto[]> {
  return request<AutopilotStatusDto[]>('/api/autopilot');
}

export function setAutopilot(
  creatorId: string,
  request: SetAutopilotRequest,
): Promise<AutopilotStatusDto> {
  return jsonRequest<AutopilotStatusDto>(
    'PUT',
    `/api/autopilot/${encodeURIComponent(creatorId)}`,
    request,
  );
}

export function checkAutopilotNow(creatorId: string): Promise<AutopilotStatusDto> {
  return jsonRequest<AutopilotStatusDto>(
    'POST',
    `/api/autopilot/${encodeURIComponent(creatorId)}/check`,
    {},
  );
}
