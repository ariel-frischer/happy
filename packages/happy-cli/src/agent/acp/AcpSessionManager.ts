import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

export class AcpSessionManager {
  private currentTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();
  /** The turn each tool call started in, by session call id. */
  private readonly callTurns = new Map<string, string | null>();
  private runningCalls: string[] = [];

  /**
   * `callIdsOutliveTurns`: the producer's tool call ids are unique for the
   * whole session, so a call keeps its card after its turn ends (omp's
   * background subagents update their task card later). ACP agents may reuse
   * ids across turns, so by default each turn starts a fresh mapping.
   */
  constructor(private readonly options: { callIdsOutliveTurns?: boolean } = {}) {}

  private forgetTurnCalls(): void {
    this.runningCalls = [];
    if (this.options.callIdsOutliveTurns) return;
    this.acpCallToSessionCall.clear();
    this.callTurns.clear();
  }

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  /**
   * The id the app sees for an agent tool call. Session-protocol call ids are
   * generated here, so anything else that refers to the call (such as a form
   * communication's `toolUseId`) must go through this to match the tool card.
   */
  sessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  /** The session call id of the most recently started tool call still running. */
  runningSessionCallId(): string | undefined {
    return this.runningCalls.at(-1);
  }

  private flush(): SessionEnvelope[] {
    if (!this.pendingText || !this.pendingType) {
      return [];
    }
    const text = this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;

    if (!text) {
      return [];
    }
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(this.currentTurnId, this.nextTime()))];
    }
    return [createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime()))];
  }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.forgetTurnCalls();
    return [
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.forgetTurnCalls();
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'thinking') {
      const { text, streaming } = parseThinkingPayload(msg.payload);
      if (!text) {
        return [];
      }

      if (streaming) {
        // Streaming thinking: accumulate, flush if switching from a different type
        const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
        this.pendingType = 'thinking';
        this.pendingText += text;
        return flushed;
      }

      // Non-streaming thinking: flush pending, emit immediately
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return this.flush();
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      if (msg.status === 'error' && this.currentTurnId) {
        const detail = msg.detail?.trim() || 'The agent stopped because of an unknown error.';
        return [
          ...this.flush(),
          createEnvelope(
            'agent',
            { t: 'service', text: `Error: ${detail}` },
            { turn: this.currentTurnId, time: this.nextTime() },
          ),
        ];
      }
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Accumulate output, flush if switching from a different type
      const flushed = this.pendingType !== 'output' ? this.flush() : [];
      this.pendingType = 'output';
      this.pendingText += text;
      return flushed;
    }

    if (msg.type === 'tool-call') {
      return this.toolCallStart(msg.callId, msg.toolName, msg.args);
    }

    if (msg.type === 'tool-result') {
      return this.toolCallEnd(msg.callId);
    }

    return [];
  }

  /**
   * A finished agent message (or thinking block), sent now rather than held
   * until the next tool call or turn end: a producer that only reports whole
   * messages has nothing more to add to it.
   */
  completeText(text: string, thinking = false): SessionEnvelope[] {
    const trimmed = text.replace(/^\n+|\n+$/g, '');
    const flushed = this.flush();
    if (!trimmed) {
      return flushed;
    }
    return [
      ...flushed,
      createEnvelope('agent', { t: 'text', text: trimmed, ...(thinking ? { thinking: true } : {}) }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }

  /**
   * Starts a tool call, or restates a running one: the app merges a repeated
   * `tool-call-start` for the same call into its card (e.g. a new description).
   */
  toolCallStart(acpCallId: string, toolName: string, args: Record<string, unknown>, description?: string): SessionEnvelope[] {
    const flushed = this.flush();
    const call = this.sessionCallId(acpCallId);
    if (!this.runningCalls.includes(call)) {
      this.runningCalls.push(call);
    }
    if (!this.callTurns.has(call)) {
      this.callTurns.set(call, this.currentTurnId);
    }
    return [
      ...flushed,
      createEnvelope('agent', {
        t: 'tool-call-start',
        call,
        name: toolName,
        title: buildToolTitle(toolName),
        description: description || buildToolDescription(toolName),
        args,
      }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }

  /**
   * Restates a tool call's card (e.g. a new description) without reopening it,
   * also after it ended; it stays in the turn it started in.
   */
  toolCallRestate(acpCallId: string, toolName: string, args: Record<string, unknown>, description?: string): SessionEnvelope[] {
    const call = this.sessionCallId(acpCallId);
    const turn = this.callTurns.has(call) ? this.callTurns.get(call)! : this.currentTurnId;
    return [
      createEnvelope('agent', {
        t: 'tool-call-start',
        call,
        name: toolName,
        title: buildToolTitle(toolName),
        description: description || buildToolDescription(toolName),
        args,
      }, turnOptions(turn, this.nextTime())),
    ];
  }

  /** Ends a tool call; `result` is its text output when the producer mirrors it. */
  toolCallEnd(acpCallId: string, outcome: { result?: string; isError?: boolean } = {}): SessionEnvelope[] {
    const flushed = this.flush();
    const call = this.sessionCallId(acpCallId);
    this.runningCalls = this.runningCalls.filter(running => running !== call);
    return [
      ...flushed,
      createEnvelope('agent', {
        t: 'tool-call-end',
        call,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.isError !== undefined ? { isError: outcome.isError } : {}),
      }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }

  /** Envelope options for an agent event in the current turn. */
  agentEnvelopeOptions(): CreateEnvelopeOptions {
    return turnOptions(this.currentTurnId, this.nextTime());
  }
}
