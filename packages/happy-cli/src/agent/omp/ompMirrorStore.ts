/**
 * Which Happy session mirrors which omp session, so `/resume` (and `omp -c`)
 * reattach to the Happy session that already holds the conversation instead of
 * opening an empty one. Kept in ~/.happy/omp-mirrors.json (0600: it holds
 * session keys; the server only has them encrypted for the app).
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { HappySessionEncryption } from '@/agent/happySession';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

/** Oldest records beyond this are forgotten; their omp sessions get a fresh, backfilled mirror. */
const MAX_RECORDS = 1000;

export type OmpMirrorRecord = {
  happySessionId: string;
  tag: string;
  encryption: HappySessionEncryption;
  /** Last omp session entry the Happy session is known to show. */
  leafId?: string;
};

type StoredRecord = {
  happySessionId: string;
  tag: string;
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  leafId?: string;
  updatedAt: number;
};

function storePath(): string {
  return join(configuration.happyHomeDir, 'omp-mirrors.json');
}

function readAll(): Record<string, StoredRecord> {
  try {
    const path = storePath();
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { mirrors?: Record<string, StoredRecord> };
    return data.mirrors && typeof data.mirrors === 'object' ? data.mirrors : {};
  } catch (error) {
    logger.debug('[omp-bridge] failed to read omp-mirrors.json:', error);
    return {};
  }
}

function writeAll(mirrors: Record<string, StoredRecord>): void {
  const entries = Object.entries(mirrors).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
  const path = storePath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mirrors: Object.fromEntries(entries) }), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readOmpMirror(ompSessionId: string): OmpMirrorRecord | null {
  const stored = readAll()[ompSessionId];
  if (!stored?.happySessionId || !stored.tag || !stored.encryptionKey) return null;
  return {
    happySessionId: stored.happySessionId,
    tag: stored.tag,
    encryption: { key: decodeBase64(stored.encryptionKey), variant: stored.encryptionVariant },
    ...(stored.leafId ? { leafId: stored.leafId } : {}),
  };
}

export function writeOmpMirror(ompSessionId: string, record: OmpMirrorRecord): void {
  try {
    const mirrors = readAll();
    mirrors[ompSessionId] = {
      happySessionId: record.happySessionId,
      tag: record.tag,
      encryptionKey: encodeBase64(record.encryption.key),
      encryptionVariant: record.encryption.variant,
      ...(record.leafId ? { leafId: record.leafId } : {}),
      updatedAt: Date.now(),
    };
    writeAll(mirrors);
  } catch (error) {
    logger.debug('[omp-bridge] failed to write omp-mirrors.json:', error);
  }
}
