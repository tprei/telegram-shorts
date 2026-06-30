import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const OptionalStringSchema = z.preprocess((value) => typeof value === 'string' && value.trim().length === 0 ? undefined : value, z.string().min(1).optional());

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: OptionalStringSchema,
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1).default('google/gemini-3.5-flash'),
  TELEGRAM_SHORTS_TRANSCRIPT_PROVIDER: z.enum(['deepgram', 'scribe']).default('deepgram'),
  DEEPGRAM_API_KEY: OptionalStringSchema,
  ELEVENLABS_API_KEY: OptionalStringSchema,
  MALLARY_AI_API_TOKEN: OptionalStringSchema,
  MALLARY_PROFILE_ID: OptionalStringSchema,
  BUFFER_API_KEY: OptionalStringSchema,
  BUFFER_ORGANIZATION_ID: OptionalStringSchema,
  BUFFER_INSTAGRAM_CHANNEL_ID: OptionalStringSchema,
  BUFFER_INSTAGRAM_CHANNEL_NAME: OptionalStringSchema,
  BUFFER_TIKTOK_CHANNEL_ID: OptionalStringSchema,
  BUFFER_TIKTOK_CHANNEL_NAME: OptionalStringSchema,
  BUFFER_YOUTUBE_CHANNEL_ID: OptionalStringSchema,
  BUFFER_YOUTUBE_CHANNEL_NAME: OptionalStringSchema,
  BUFFER_PUBLIC_MEDIA_BASE_URL: OptionalStringSchema,
  TELEGRAM_SHORTS_INSTAGRAM_PUBLISH_PROVIDERS: z.string().default('mallary,buffer'),
  TELEGRAM_SHORTS_DB_PATH: z.string().default('work/telegram-shorts/shorts.sqlite'),
  TELEGRAM_SHORTS_ARTIFACTS_DIR: z.string().default('work/telegram-shorts/artifacts'),
  TELEGRAM_SHORTS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  TELEGRAM_SHORTS_ALLOWED_USER_ID: OptionalStringSchema,
  TELEGRAM_SHORTS_MAX_FILE_BYTES: z.coerce.number().int().positive().default(45_000_000),
  TELEGRAM_SHORTS_STATIC_LAYOUT_PATH: OptionalStringSchema,
  TELEGRAM_SHORTS_RENDER_TIER: z.enum(['dev', 'prod']).default('dev'),
  TELEGRAM_SHORTS_YTDLP_COOKIES_PATH: OptionalStringSchema,
  TELEGRAM_SHORTS_YTDLP_COOKIES_FROM_BROWSER: OptionalStringSchema,
  TELEGRAM_SHORTS_YTDLP_JS_RUNTIME: OptionalStringSchema,
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  rootDir: string;
  dbPath: string;
  artifactsDir: string;
};

let loaded = false;

export function loadConfig(): AppConfig {
  if (!loaded) {
    for (const path of candidateEnvPaths()) {
      if (existsSync(path)) {
        applyEnvFile(path);
      }
    }
    loaded = true;
  }
  const parsed = EnvSchema.parse(process.env);
  const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  return {
    ...parsed,
    rootDir,
    dbPath: resolve(rootDir, parsed.TELEGRAM_SHORTS_DB_PATH),
    artifactsDir: resolve(rootDir, parsed.TELEGRAM_SHORTS_ARTIFACTS_DIR),
  };
}

function candidateEnvPaths(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(moduleDir, '../..');
  return [join(repoRoot, '.env')];
}

function applyEnvFile(path: string): void {
  const text = readFileSync(path, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = assignment.slice(0, separator).trim();
    if (process.env[key] !== undefined) {
      continue;
    }
    const rawValue = assignment.slice(separator + 1).trim();
    process.env[key] = unquote(rawValue);
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
