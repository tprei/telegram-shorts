import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export function readLegacyManifestAccountMap(manifestPath: string): Map<string, string | null> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Creator manifest not found at ${manifestPath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Creator manifest at ${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('accounts' in parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error(`Creator manifest at ${manifestPath} has no accounts array.`);
  }
  if (!('creators' in parsed) || !Array.isArray(parsed.creators)) {
    throw new Error(`Creator manifest at ${manifestPath} has no creators array.`);
  }
  if (parsed.creators.length === 0) {
    throw new Error(`Creator manifest at ${manifestPath} has an empty creators array.`);
  }
  const accountIds = new Set<string>();
  for (const account of parsed.accounts) {
    if (typeof account !== 'object' || account === null || !('id' in account) || typeof account.id !== 'string' || account.id.length === 0) {
      throw new Error(`Creator manifest at ${manifestPath} has an account without a string id.`);
    }
    accountIds.add(account.id);
  }
  const accountMap = new Map<string, string | null>();
  for (const creator of parsed.creators) {
    if (typeof creator !== 'object' || creator === null || !('id' in creator) || typeof creator.id !== 'string' || creator.id.length === 0) {
      throw new Error(`Creator manifest at ${manifestPath} has a creator without a string id.`);
    }
    if (accountMap.has(creator.id)) {
      throw new Error(`Creator manifest at ${manifestPath} lists creator ${creator.id} more than once.`);
    }
    if (creator.accountId !== null && typeof creator.accountId !== 'string') {
      throw new Error(`Creator manifest at ${manifestPath} has creator ${creator.id} without a string or null accountId.`);
    }
    if (typeof creator.accountId === 'string' && !accountIds.has(creator.accountId)) {
      throw new Error(`Creator manifest at ${manifestPath} maps creator ${creator.id} to undeclared account ${creator.accountId}.`);
    }
    accountMap.set(creator.id, creator.accountId);
  }
  return accountMap;
}

export function migrateToV8(
  db: DatabaseSync,
  accountMap: Map<string, string | null>,
): void {
  const [orphanExport] = db.prepare('SELECT e.id FROM exports e LEFT JOIN jobs j ON j.id = e.job_id WHERE j.id IS NULL').all();
  if (orphanExport !== undefined) {
    throw new Error(`Orphan export ${String(orphanExport.id)} has no matching job`);
  }

  const malformedJobs = db.prepare('SELECT id FROM jobs WHERE json_valid(payload_json) = 0').all();
  if (malformedJobs.length > 0) {
    throw new Error('Malformed JSON payload in jobs table');
  }

  const malformedShorts = db.prepare('SELECT id FROM shorts WHERE json_valid(payload_json) = 0').all();
  if (malformedShorts.length > 0) {
    throw new Error('Malformed JSON payload in shorts table');
  }

  const malformedExports = db.prepare('SELECT id FROM exports WHERE json_valid(payload_json) = 0').all();
  if (malformedExports.length > 0) {
    throw new Error('Malformed JSON payload in exports table');
  }

  const nonV2Jobs = db.prepare("SELECT id FROM jobs WHERE json_extract(payload_json, '$.layoutProfileSnapshot.version') != 2").all();
  if (nonV2Jobs.length > 0) {
    const row = nonV2Jobs[0] as { id: string };
    throw new Error(`Job ${row.id} does not have a version 2 layout snapshot`);
  }

  const invalidSpeedJobs = db.prepare(
    "SELECT id FROM jobs WHERE json_extract(payload_json, '$.layoutProfileSnapshot.defaultSpeed') IS NULL OR (typeof(json_extract(payload_json, '$.layoutProfileSnapshot.defaultSpeed')) != 'integer' AND typeof(json_extract(payload_json, '$.layoutProfileSnapshot.defaultSpeed')) != 'real')",
  ).all();
  if (invalidSpeedJobs.length > 0) {
    const row = invalidSpeedJobs[0] as { id: string };
    throw new Error(`Job ${row.id} has missing or non-numeric defaultSpeed in layout snapshot`);
  }

  const legacyCreatorIds: Array<string | null> = [];
  for (const row of db.prepare(`
    SELECT json_extract(payload_json, '$.creatorProfileSnapshot.id') AS creator_id
    FROM jobs
    WHERE (
      json_extract(payload_json, '$.creatorProfileSnapshot.publish.instagram.mode') = 'global'
      OR json_extract(payload_json, '$.creatorProfileSnapshot.publish.tiktok.mode') = 'global'
      OR json_extract(payload_json, '$.creatorProfileSnapshot.publish.youtube_shorts.mode') = 'global'
    )
  `).all()) {
    if (typeof row === 'object' && row !== null && 'creator_id' in row) {
      const creatorId = row.creator_id;
      if (typeof creatorId === 'string' || creatorId === null) {
        legacyCreatorIds.push(creatorId);
      }
    }
  }

  for (const creatorId of legacyCreatorIds) {
    if (creatorId === null) {
      continue;
    }
    const mappedAccount = accountMap.get(creatorId);
    if (!mappedAccount) {
      throw new Error(`Cannot map legacy publishing creator ${creatorId} to an account.`);
    }
  }

  const caseBranches: string[] = [];
  for (const [creatorId, accountId] of accountMap.entries()) {
    if (accountId !== null) {
      caseBranches.push(`WHEN '${creatorId.replace(/'/g, "''")}' THEN '${accountId.replace(/'/g, "''")}'`);
    }
  }
  const accountValueSql = caseBranches.length > 0
    ? `CASE json_extract(payload_json, '$.creatorProfileSnapshot.id') ${caseBranches.join(' ')} ELSE json('null') END`
    : `json('null')`;

  db.exec(`
    UPDATE jobs
    SET payload_json = json_remove(
      json_set(payload_json,
        '$.creatorProfileSnapshot.accountId',
          ${accountValueSql},
        '$.creatorProfileSnapshot.render.defaultSpeed', json_extract(payload_json, '$.layoutProfileSnapshot.defaultSpeed'),
        '$.creatorProfileSnapshot.render.scene', json('null'),
        '$.layoutProfileSnapshot.version', 3,
        '$.layoutProfileSnapshot.strategy', 'fixed',
        '$.layoutProfileSnapshot.safeArea', json('{"top":0,"bottom":0,"side":0}'),
        '$.sceneTrack', json('null'),
        '$.sceneAnalysis', 'none',
        '$.sceneAnalysisError', json('null')
      ),
      '$.creatorProfileSnapshot.schedule', '$.creatorProfileSnapshot.publish',
      '$.layoutProfileSnapshot.creatorId', '$.layoutProfileSnapshot.defaultSpeed'
    );

    UPDATE shorts
    SET payload_json = json_set(payload_json,
      '$.edit.layout', json('{"split":null,"overrides":[]}')
    );

    UPDATE exports
    SET payload_json = json_set(payload_json,
      '$.edit.layout', json('{"split":null,"overrides":[]}'),
      '$.layoutProfileSnapshot', json((
        SELECT json_extract(j.payload_json, '$.layoutProfileSnapshot')
        FROM jobs j WHERE j.id = exports.job_id
      )),
      '$.sceneTrack', json('null')
    );
  `);
}
