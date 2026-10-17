export interface StudioMediaResolver {
  sourceVideoPath(jobId: string): string;
  thumbnailPath(jobId: string): string;
  framePath(jobId: string, seconds: number, width: number): Promise<string>;
  exportVideoPath(exportId: string): string;
  exportCoverPath(exportId: string): string;
}
