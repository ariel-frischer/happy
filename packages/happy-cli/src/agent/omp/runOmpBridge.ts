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
import { OMP_BRIDGE_PROTOCOL_VERSION, parseExtToBridgeLine, type BridgeToExt, type ExtToBridge, type OmpAskQuestion, type OmpSessionInfo } from './bridgeProtocol';
import { OmpBridgeMapper } from './OmpBridgeMapper';
import { formAnswersToOmpAsk, ompAskToForm, ompAskToFormAnswers } from './ompAskForm';

const LOG = '[omp-bridge]';
const KEEP_ALIVE_MS = 2000;
const PUSH_BODY_MAX = 140;

type Mirror = {
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
};

function send(message: BridgeToExt): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function titleMetadata(title: string | undefined) {
  return title ? { name: title, summary: { text: title, updatedAt: Date.now() } } : {};
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

  const detach = async (mirror: Mirror, reason: string) => {
    if (mirror.closed) return;
    await closeMirror(mirror, reason);
    send({ t: 'detached', reason });
  };

  const wire = (mirror: Mirror, session: ApiSessionClient) => {
    session.onUserMessage((message) => {
      const text = message.content.text;
      if (mirror.closed || !text) return;
      logger.debug(`${LOG} app message -> omp (${text.length} chars)`);
      mirror.appTurn = true;
      send({ t: 'user_message', text });
    });
    session.rpcHandlerManager.registerHandler('abort', async () => {
      if (!mirror.closed) send({ t: 'abort' });
    });
    registerKillSessionHandler(session.rpcHandlerManager, () => detach(mirror, 'Stopped from the Happy app'));
    // The offline stub is not an EventEmitter; archive signals only come from a live socket.
    if (typeof session.on === 'function') {
      session.on('archived', () => void detach(mirror, 'Archived from the Happy app'));
    }
  };

  const openMirror = async (info: OmpSessionInfo, hostPid: number) => {
    let mirror: Mirror | null = null;
    const opened = await openHappySession({
      api,
      machineId,
      flavor: 'omp',
      startedBy,
      sandbox: settings.sandboxConfig,
      // hostPid is the omp TUI: the daemon matches tmux-spawned sessions by
      // pane pid and stops sessions by signalling this pid.
      metadataOverrides: { path: info.cwd, hostPid, ...titleMetadata(info.title) },
      logPrefix: LOG,
      onSessionSwap: (session) => {
        if (!mirror || mirror.closed) return;
        mirror.session = session;
        wire(mirror, session);
        mirror.forms.updateSession(session);
      },
    });
    const created: Mirror = {
      session: opened.session,
      opened,
      mapper: new OmpBridgeMapper(),
      keepAlive: setInterval(() => created.session.keepAlive(created.thinking, 'remote'), KEEP_ALIVE_MS),
      thinking: false,
      closed: false,
      asks: new Map(),
      forms: new FormCommunicationBridge(opened.session, LOG),
      appTurn: false,
    };
    mirror = created;
    wire(created, created.session);
    // Forms a previous bridge process left open can no longer be answered.
    created.forms.cancelAll('Previous omp bridge exited before responding');
    created.session.keepAlive(false, 'remote');
    current = created;
    logger.debug(`${LOG} opened Happy session ${opened.id} for omp session ${info.ompSessionId} in ${info.cwd}`);
    send({ t: 'ready', v: OMP_BRIDGE_PROTOCOL_VERSION, happySessionId: opened.id });
  };

  const pushNotification = (mirror: Mirror, kind: 'done' | 'question', data: Record<string, unknown>, body?: string) => {
    api.push().sendSessionNotification({
      kind,
      metadata: mirror.session.getMetadata(),
      data: { sessionId: mirror.opened.id, provider: 'omp', ...data },
      ...(body ? { body } : {}),
    });
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
      default: {
        const mirror = current;
        if (!mirror) return;
        const mapped = mirror.mapper.map(event);
        for (const envelope of mapped.envelopes) {
          mirror.session.sendSessionProtocolMessage(envelope);
        }
        if (mapped.thinking !== undefined && mapped.thinking !== mirror.thinking) {
          mirror.thinking = mapped.thinking;
          mirror.session.keepAlive(mirror.thinking, 'remote');
        }
        if (mapped.turnEnded) {
          mirror.session.sendSessionEvent({ type: 'ready' });
          // Like Claude's remote mode: tell the phone a turn it started is done.
          if (mirror.appTurn && event.t === 'status' && (event.outcome ?? 'completed') === 'completed' && !event.error) {
            pushNotification(mirror, 'done', { type: 'ready' });
          }
          mirror.appTurn = false;
        }
      }
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
