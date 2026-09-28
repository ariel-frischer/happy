import { randomUUID } from 'node:crypto';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import type { SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { createSessionMetadata, type BackendFlavor } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection, type SetupOfflineReconnectionResult } from '@/utils/setupOfflineReconnection';

export type HappySessionEncryption = { key: Uint8Array; variant: 'legacy' | 'dataKey' };

export type OpenedHappySession = {
  /** Happy session id, or null while the server is unreachable (offline reconnection pending). */
  id: string | null;
  session: ApiSessionClient;
  metadata: Metadata;
  reconnectionHandle: SetupOfflineReconnectionResult['reconnectionHandle'];
  /** Server tag and key; pass both back as `reopen` to reattach to this session later. */
  tag: string;
  encryption: HappySessionEncryption | null;
};

/**
 * Create a Happy session row (or reopen the one `reopen` names), attach the
 * offline-reconnection client, and report it to the local daemon so the app
 * can resume/stop it.
 */
export async function openHappySession(opts: {
  api: ApiClient;
  machineId: string;
  flavor: BackendFlavor;
  startedBy?: 'daemon' | 'terminal';
  sandbox?: SandboxConfig;
  /** Applied on top of the generated metadata (path, hostPid, name, summary, …). */
  metadataOverrides?: Partial<Metadata>;
  onSessionSwap: (session: ApiSessionClient) => void;
  logPrefix: string;
  /**
   * Reattach to a session this machine opened before. The server keeps its
   * messages and returns it by tag; if it was deleted, a new one is created.
   * Either way it gets fresh metadata and agent state (no longer archived).
   */
  reopen?: { tag: string; encryption: HappySessionEncryption };
}): Promise<OpenedHappySession> {
  const created = createSessionMetadata({
    flavor: opts.flavor,
    machineId: opts.machineId,
    startedBy: opts.startedBy,
    sandbox: opts.sandbox,
  });
  const state = created.state;
  const metadata: Metadata = { ...created.metadata, ...opts.metadataOverrides };
  const sessionTag = opts.reopen?.tag ?? randomUUID();
  const encryption = opts.reopen?.encryption;
  const response = await opts.api.getOrCreateSession({ tag: sessionTag, metadata, state, encryption });

  const { session, reconnectionHandle } = setupOfflineReconnection({
    api: opts.api,
    sessionTag,
    metadata,
    state,
    response,
    encryption,
    onSessionSwap: opts.onSessionSwap,
  });

  if (response && opts.reopen) {
    // The server ignores the metadata sent for an existing tag.
    session.updateMetadata(() => metadata);
    session.updateAgentState(() => state);
  }

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug(`${opts.logPrefix} Failed to report session to daemon:`, error);
    }
  }

  return {
    id: response?.id ?? null,
    session,
    metadata,
    reconnectionHandle,
    tag: sessionTag,
    encryption: response ? { key: response.encryptionKey, variant: response.encryptionVariant } : (encryption ?? null),
  };
}

/** Mark a session archived, announce its end, and close the socket. Never throws. */
export async function archiveHappySession(session: ApiSessionClient, reason: string, logPrefix: string): Promise<void> {
  try {
    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
      archivedBy: 'cli',
      archiveReason: reason,
    }));
    session.sendSessionDeath();
    await session.flush();
    await session.close();
  } catch (error) {
    logger.debug(`${logPrefix} Session close failed:`, error);
  }
}
