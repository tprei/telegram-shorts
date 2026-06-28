import { relative } from 'node:path';
import { AppConfig } from './env.js';
import { MallaryUploadClient } from './mallary.js';

export interface PublicAssetHost {
  readonly name: string;
  hostFile(path: string): Promise<string>;
}

export function createPublicAssetHost(config: AppConfig): PublicAssetHost | null {
  if (config.BUFFER_PUBLIC_MEDIA_BASE_URL) {
    return new BaseUrlPublicAssetHost(config.artifactsDir, config.BUFFER_PUBLIC_MEDIA_BASE_URL);
  }
  if (config.MALLARY_AI_API_TOKEN) {
    return new MallaryPublicAssetHost(new MallaryUploadClient(config.MALLARY_AI_API_TOKEN));
  }
  return null;
}

class MallaryPublicAssetHost implements PublicAssetHost {
  readonly name = 'mallary-cdn';

  constructor(private readonly uploader: MallaryUploadClient) {}

  async hostFile(path: string): Promise<string> {
    const upload = await this.uploader.uploadFile(path);
    return upload.mediaUrl;
  }
}

class BaseUrlPublicAssetHost implements PublicAssetHost {
  readonly name = 'public-base-url';

  constructor(
    private readonly artifactsDir: string,
    private readonly baseUrl: string,
  ) {}

  async hostFile(path: string): Promise<string> {
    const relativePath = relative(this.artifactsDir, path).replaceAll('\\', '/');
    if (relativePath.startsWith('../') || relativePath === '..') {
      throw new Error(`Path is outside artifacts dir and cannot be mapped to public URL: ${path}`);
    }
    return new URL(relativePath, ensureTrailingSlash(this.baseUrl)).toString();
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
