/**
 * `happy omp-bridge`: long-lived stdio child of an interactive omp TUI (spawned by
 * the omp `happy-bridge` extension). Mirrors the TUI session into a Happy session
 * and relays app messages back into omp. See ./bridgeProtocol.ts for the wire format.
 */
import { createInterface } from 'node:readline';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { FormCommunicationBridge } from '@/agent/formCommunicationBridge';
import { archiveHappySession, openHappySession, type OpenedHappySession } from '@/agent/happySession';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { initialMachineMetadata } from '@/daemon/run';
import { readCredentials, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { connectionState } from '@/utils/serverConnectionErrors';
import { detectImageMime, extensionForImageMime, readImageSize } from '@/utils/imageFormat';
import { OMP_BRIDGE_PROTOCOL_VERSION, parseExtToBridgeLine, type BridgeToExt, type ExtToBridge, type OmpAskQuestion, type OmpConfig, type OmpHistoryEvent, type OmpImage, type OmpSessionInfo } from './bridgeProtocol';
import { ompConfigMetadata } from './ompConfigMetadata';
import { OmpBridgeMapper } from './OmpBridgeMapper';
import { formAnswersToOmpAsk, ompAskToForm, ompAskToFormAnswers } from './ompAskForm';
import { readOmpMirror, writeOmpMirror } from './ompMirrorStore';

const LOG = '[omp-bridge]';
const KEEP_ALIVE_MS = 2000;
const PUSH_BODY_MAX = 140;
/** Total decoded image bytes one app message may hand to omp. */
const APP_IMAGES_MAX_BYTES = 20 * 1024 * 1024;
/** omp commands the extension runs when typed in the app (plus /compact, an app default). */
const APP_SLASH_COMMANDS = ['model', 'thinking', 'exit', 'quit'];

type Mirror = {
  /** The omp session this mirrors. */
  ompSessionId: string;
  session: ApiSessionClient;
  opened: OpenedHappySession;
  mapper: OmpBridgeMapper;
  keepAlive: NodeJS.Timeout;
  thinking: boolean;
  closed: boolean;
  /** `ask` dialogs shown in the app, by ask id; removed once either side settles. */
  asks: Map<string, OmpAskQuestion[]>;
  forms: FormCommunicationBridge;
  /** A message from the app arrived since the last finished turn. */
  appTurn: boolean;
  /** App messages wait for their attachments; this keeps them in order. */
  inbound: Promise<void>;
  /** Transient busy detail last written to the agent state. */
  activity: string | null;
};

function send(message: BridgeToExt): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function titleMetadata(title: string | undefined) {
  return title ? { name: title, summary: { text: title, updatedAt: Date.now() } } : {};
}

/** App attachments a model can read, as omp image blocks; unknown formats are dropped. */
function toOmpImages(attachments: Array<{ data: Uint8Array; name: string }>): OmpImage[] {
  const images: OmpImage[] = [];
  let total = 0;
  for (const attachment of attachments) {
    const mimeType = detectImageMime(attachment.data);
    if (!mimeType) {
      logger.debug(`${LOG} dropping attachment ${attachment.name}: not a PNG/JPEG/GIF/WebP image`);
      continue;
    }
    total += attachment.data.length;
    if (total > APP_IMAGES_MAX_BYTES) {
      logger.debug(`${LOG} dropping attachment ${attachment.name}: message images exceed ${APP_IMAGES_MAX_BYTES} bytes`);
      break;
    }
    images.push({ data: Buffer.from(attachment.data).toString('base64'), mimeType });
  }
  return images;
}

export async function runOmpBridge(): Promise<void> {
  // stdout carries the protocol; keep stray console output off it.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  const credentials = await readCredentials();
  if (!credentials) {
    send({ t: 'error', message: 'Happy is not authenticated (run `happy auth login`)', fatal: true });
    process.exit(1);
  }
  connectionState.setBackend('omp');
  const api = await ApiClient.create(credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    send({ t: 'error', message: 'Happy has no machine id (run `happy` once to set up)', fatal: true });
    process.exit(1);
  }
  const machineId = settings.machineId;
  await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });
  const startedBy = process.env.HAPPY_OMP_STARTED_BY === 'daemon' ? 'daemon' : 'terminal';
  logger.debug(`${LOG} started (startedBy ${startedBy})`);

  let current: Mirror | null = null;
  /** From `hello`; null until the extension has introduced itself. */
  let ompPid: number | null = null;
  /** omp's model and thinking level as last reported; carried into every mirror. */
  let config: OmpConfig = {};

  const closeMirror = async (mirror: Mirror, reason: string) => {
    if (mirror.closed) return;
    mirror.closed = true;
    if (current === mirror) current = null;
    clearInterval(mirror.keepAlive);
    mirror.opened.reconnectionHandle?.cancel();
    // The TUI dialogs stay up; only the app forms go away.
    mirror.asks.clear();
    mirror.forms.cancelAll(reason);
    await archiveHappySession(mirror.session, reason, LOG);
    logger.debug(`${LOG} closed Happy session ${mirror.opened.id}: ${reason}`);
  };

  /** The app put the session away: archive it here, then have omp quit. */
  const exitOmp = async (mirror: Mirror, reason: string) => {
    if (mirror.closed) return;
    await closeMirror(mirror, reason);
    send({ t: 'exit', reason });
  };

  const wire = (mirror: Mirror, session: ApiSessionClient) => {
    session.onFileEvent((fileEvent) => {
      const ev = fileEvent.content.data.ev;
      session.trackAttachmentDownload(session.downloadAndDecryptAttachment(ev.ref).then(
        (data) => (data ? { data, mimeType: ev.mimeType ?? 'image/jpeg', name: ev.name } : null),
        (error) => {
          logger.debug(`${LOG} failed to download attachment ${ev.name}:`, error);
          return null;
        },
      ));
    });
    session.onUserMessage((message) => {
      const text = message.content.text ?? '';
      // Attachments arrive as file events just before their message's text.
      mirror.inbound = mirror.inbound.then(async () => {
        const images = toOmpImages(await session.drainAttachmentsForUserMessage());
        if (mirror.closed || (!text && images.length === 0)) return;
        logger.debug(`${LOG} app message -> omp (${text.length} chars, ${images.length} images)`);
        mirror.appTurn = true;
        send({ t: 'user_message', text, ...(images.length > 0 ? { images } : {}) });
      }).catch((error) => logger.debug(`${LOG} failed to relay app message:`, error));
    });
    session.rpcHandlerManager.registerHandler('abort', async () => {
      if (!mirror.closed) send({ t: 'abort' });
    });
    session.rpcHandlerManager.registerHandler<{ id?: unknown }, void>('cancelJob', async (params) => {
      if (!mirror.closed && typeof params?.id === 'string') send({ t: 'cancel_job', id: params.id });
    });
    // The composer's effort picker; omp answers with a `config` that moves the chip.
    session.rpcHandlerManager.registerHandler<{ level?: unknown }, void>('setThinkingLevel', async (params) => {
      if (!mirror.closed && typeof params?.level === 'string') send({ t: 'set_thinking', level: params.level });
    });
    registerKillSessionHandler(session.rpcHandlerManager, () => exitOmp(mirror, 'Stopped from the Happy app'));
    // The offline stub is not an EventEmitter; archive signals only come from a live socket.
    if (typeof session.on === 'function') {
      session.on('archived', () => void exitOmp(mirror, 'Archived from the Happy app'));
    }
  };

  /** Remembers which Happy session shows `ompSessionId`, through omp entry `leafId`. */
  const recordMirror = (mirror: Mirror, leafId: string | undefined) => {
    const { id, tag, encryption } = mirror.opened;
    if (!id || !encryption) return; // offline: nothing to reattach to yet
    writeOmpMirror(mirror.ompSessionId, { happySessionId: id, tag, encryption, ...(leafId ? { leafId } : {}) });
  };

  /**
   * Mirrors omp session `info`. A session mirrored before gets its Happy
   * session back (history intact, un-archived); otherwise a new one is opened
   * and the extension is asked to backfill the omp history into it.
   */
  const openMirror = async (info: OmpSessionInfo, hostPid: number) => {
    let mirror: Mirror | null = null;
    const previous = readOmpMirror(info.ompSessionId);
    const opened = await openHappySession({
      api,
      machineId,
      flavor: 'omp',
      startedBy,
      sandbox: settings.sandboxConfig,
      // hostPid is the omp TUI: the daemon matches tmux-spawned sessions by
      // pane pid and stops sessions by signalling this pid.
      metadataOverrides: { path: info.cwd, hostPid, slashCommands: APP_SLASH_COMMANDS, ...titleMetadata(info.title), ...ompConfigMetadata(config) },
      logPrefix: LOG,
      ...(previous ? { reopen: { tag: previous.tag, encryption: previous.encryption } } : {}),
      onSessionSwap: (session) => {
        if (!mirror || mirror.closed) return;
        mirror.session = session;
        wire(mirror, session);
        mirror.forms.updateSession(session);
      },
    });
    const created: Mirror = {
      ompSessionId: info.ompSessionId,
      session: opened.session,
      opened,
      mapper: new OmpBridgeMapper(),
      keepAlive: setInterval(() => created.session.keepAlive(created.thinking, 'remote'), KEEP_ALIVE_MS),
      thinking: false,
      closed: false,
      asks: new Map(),
      forms: new FormCommunicationBridge(opened.session, LOG),
      appTurn: false,
      inbound: Promise.resolve(),
      activity: null,
    };
    mirror = created;
    wire(created, created.session);
    // Forms a previous bridge process left open can no longer be answered.
    created.forms.cancelAll('Previous omp bridge exited before responding');
    created.session.keepAlive(false, 'remote');
    current = created;
    const reattached = previous !== null && opened.id === previous.happySessionId;
    recordMirror(created, reattached ? previous.leafId : undefined);
    logger.debug(`${LOG} ${reattached ? 'reattached' : 'opened'} Happy session ${opened.id} for omp session ${info.ompSessionId} in ${info.cwd}`);
    // Offline (no id): the session may exist or not; skip the backfill rather than guess.
    const backfill = opened.id === null ? undefined : reattached ? (previous.leafId ? { afterEntryId: previous.leafId } : undefined) : {};
    send({ t: 'ready', v: OMP_BRIDGE_PROTOCOL_VERSION, happySessionId: opened.id, ...(backfill ? { backfill } : {}) });
  };

  const pushNotification = (mirror: Mirror, kind: 'done' | 'question', data: Record<string, unknown>, body?: string) => {
    api.push().sendSessionNotification({
      kind,
      metadata: mirror.session.getMetadata(),
      data: { sessionId: mirror.opened.id, provider: 'omp', ...data },
      ...(body ? { body } : {}),
    });
  };

  /** Uploads an omp image and posts it to the Happy session as a `file` event. */
  const postImage = async (mirror: Mirror, image: OmpImage, index: number, role: 'user' | 'agent') => {
    const data = Buffer.from(image.data, 'base64');
    const size = readImageSize(data);
    try {
      const envelope = await mirror.session.uploadLocalImageAttachmentEnvelope(
        { data, mimeType: image.mimeType, name: `omp-image-${index + 1}.${extensionForImageMime(image.mimeType)}`, ...(size ? { image: size } : {}) },
        role === 'agent' ? { role, ...mirror.mapper.agentEnvelopeOptions() } : { role },
      );
      if (!mirror.closed) mirror.session.sendSessionProtocolMessage(envelope);
    } catch (error) {
      logger.debug(`${LOG} failed to upload an omp image:`, error);
    }
  };

  const setActivity = (mirror: Mirror, activity: string | null) => {
    if (mirror.activity === activity) return;
    mirror.activity = activity;
    mirror.session.updateAgentState((state) => ({ ...state, activity }));
  };

  /** `replay`: a history event; it changes neither the busy state nor notifies. */
  const sendMapped = (mirror: Mirror, event: ExtToBridge, replay = false) => {
    const mapped = mirror.mapper.map(event);
    for (const envelope of mapped.envelopes) {
      mirror.session.sendSessionProtocolMessage(envelope);
    }
    if (replay) return;
    if (mapped.thinking !== undefined && mapped.thinking !== mirror.thinking) {
      mirror.thinking = mapped.thinking;
      mirror.session.keepAlive(mirror.thinking, 'remote');
    }
    if (mapped.turnEnded) {
      setActivity(mirror, null);
      mirror.session.sendSessionEvent({ type: 'ready' });
      // Like Claude's remote mode: tell the phone a turn it started is done.
      if (mirror.appTurn && event.t === 'status' && (event.outcome ?? 'completed') === 'completed' && !event.error) {
        pushNotification(mirror, 'done', { type: 'ready' });
      }
      mirror.appTurn = false;
    }
  };

  /** Sends a conversation event, with its images, to the Happy session. */
  const relay = async (mirror: Mirror, event: ExtToBridge, replay = false) => {
    if (event.t === 'user') {
      // Like app messages: the pictures first, then the text they go with.
      for (const [index, image] of (event.images ?? []).entries()) await postImage(mirror, image, index, 'user');
      sendMapped(mirror, event, replay);
      return;
    }
    sendMapped(mirror, event, replay);
    // Shown right under the tool card they came from.
    if (event.t === 'tool_end') {
      for (const [index, image] of (event.images ?? []).entries()) await postImage(mirror, image, index, 'agent');
    }
  };

  const replayHistory = async (mirror: Mirror, events: OmpHistoryEvent[], omitted: number, leafId: string | undefined) => {
    logger.debug(`${LOG} backfilling ${events.length} omp events into ${mirror.opened.id} (${omitted} older messages omitted)`);
    if (omitted > 0) {
      mirror.session.sendSessionEvent({ type: 'message', message: `… ${omitted} earlier message${omitted === 1 ? '' : 's'} not shown` });
    }
    for (const event of events) {
      if (mirror.closed) return;
      await relay(mirror, event, true);
    }
    recordMirror(mirror, leafId);
  };

  /** Shows a TUI `ask` in the app; whichever side answers first wins. */
  const openAsk = (mirror: Mirror, id: string, questions: OmpAskQuestion[], toolCallId: string | undefined) => {
    mirror.asks.set(id, questions);
    const form = ompAskToForm(questions);
    // The tool card carries the session-protocol call id, not omp's, so link
    // the form through the mapper or its answers never reach the card.
    const toolUseId = toolCallId ? mirror.mapper.sessionCallId(toolCallId) : undefined;
    void mirror.forms.open({ ...form, ...(toolUseId ? { toolUseId } : {}) }, id).then((reply) => {
      // Not pending any more: the TUI settled first or the mirror closed.
      if (!mirror.asks.delete(id) || mirror.closed) return;
      if (reply.status === 'answered') {
        logger.debug(`${LOG} ask ${id} answered in the app`);
        send({ t: 'ask_answer', id, results: formAnswersToOmpAsk(questions, reply.answers) });
      } else {
        logger.debug(`${LOG} ask ${id} dismissed in the app`);
        send({ t: 'ask_cancelled', id });
      }
    });
    const first = questions[0]?.question.trim() ?? '';
    const body = first.length > PUSH_BODY_MAX ? `${first.slice(0, PUSH_BODY_MAX - 1)}…` : first;
    pushNotification(mirror, 'question', { tool: 'ask', type: 'question_request', ...(toolCallId ? { toolCallId } : {}) }, body);
  };

  const shutdown = async (reason: string) => {
    if (current) await closeMirror(current, reason);
    process.exit(0);
  };

  const handle = async (event: ExtToBridge) => {
    switch (event.t) {
      case 'hello':
        if (event.v !== OMP_BRIDGE_PROTOCOL_VERSION) {
          send({ t: 'error', message: `omp-bridge protocol v${OMP_BRIDGE_PROTOCOL_VERSION}, extension sent v${event.v}`, fatal: true });
          process.exit(1);
        }
        ompPid = event.pid;
        if (current) await closeMirror(current, 'omp bridge restarted');
        await openMirror(event.session, event.pid);
        return;
      case 'session':
        if (ompPid === null) {
          logger.debug(`${LOG} ignoring session switch before hello`);
          return;
        }
        // Branching within the same session file keeps its mirror.
        if (current?.ompSessionId === event.session.ompSessionId) return;
        if (current) await closeMirror(current, 'omp switched session');
        await openMirror(event.session, ompPid);
        return;
      case 'end':
        await shutdown('omp exited');
        return;
      case 'ask':
        if (current) openAsk(current, event.id, event.questions, event.toolCallId);
        return;
      case 'ask_cancel': {
        const mirror = current;
        if (!mirror || !mirror.asks.delete(event.id)) return;
        mirror.forms.close(event.id, event.answers ? ompAskToFormAnswers(event.answers) : undefined);
        logger.debug(`${LOG} ask ${event.id} settled in the TUI`);
        return;
      }
      case 'title': {
        const title = event.title;
        current?.session.updateMetadata((metadata) => ({ ...metadata, ...titleMetadata(title) }));
        return;
      }
      case 'config': {
        const { t: _, ...next } = event;
        config = next;
        current?.session.updateMetadata((metadata) => ({ ...metadata, ...ompConfigMetadata(next) }));
        return;
      }
      case 'user':
      case 'tool_end':
        if (current) await relay(current, event);
        return;
      case 'history':
        if (current) await replayHistory(current, event.events, event.omitted, event.leafId);
        return;
      case 'status':
        if (!current) return;
        sendMapped(current, event);
        if (event.status === 'idle' && event.leafId) recordMirror(current, event.leafId);
        return;
      case 'notice':
        current?.session.sendSessionEvent({ type: 'message', message: event.text });
        return;
      case 'activity':
        if (current) setActivity(current, event.text || null);
        return;
      case 'jobs': {
        const mirror = current;
        if (!mirror) return;
        const backgroundJobs = event.jobs.map(({ toolCallId, ...job }) => ({
          ...job,
          ...(toolCallId ? { callId: mirror.mapper.sessionCallId(toolCallId) } : {}),
        }));
        mirror.session.updateAgentState((state) => ({ ...state, backgroundJobs }));
        return;
      }
      default:
        if (current) sendMapped(current, event);
    }
  };

  // Events are handled strictly in order: session creation is async and later
  // events must land in the session that `hello`/`session` opened.
  let queue = Promise.resolve();
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const event = parseExtToBridgeLine(line);
    if (!event) {
      if (line.trim()) logger.debug(`${LOG} ignoring malformed line: ${line.slice(0, 200)}`);
      return;
    }
    queue = queue.then(() => handle(event)).catch((error) => {
      logger.debug(`${LOG} failed to handle ${event.t}:`, error);
    });
  });
  input.on('close', () => {
    queue = queue.then(() => shutdown('omp exited'));
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      queue = queue.then(() => shutdown(`omp bridge received ${signal}`));
    });
  }
}
