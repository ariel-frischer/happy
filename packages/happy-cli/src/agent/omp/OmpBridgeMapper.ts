import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { ExtToBridge } from './bridgeProtocol';

export type OmpMappedEvent = {
  envelopes: SessionEnvelope[];
  /** New agent busy state for keep-alive, when this event changed it. */
  thinking?: boolean;
  /** A turn finished; the app expects a `ready` session event. */
  turnEnded?: boolean;
};

/**
 * Maps omp TUI events onto the same session-protocol envelopes `happy acp omp`
 * produces (via {@link AcpSessionManager}), so the app renders both identically.
 * One mapper per Happy session.
 */
export class OmpBridgeMapper {
  private readonly turns = new AcpSessionManager();

  /** The id the app's tool card uses for an omp tool call. */
  sessionCallId(ompToolCallId: string): string {
    return this.turns.sessionCallId(ompToolCallId);
  }

  /** Envelope options (turn, monotonic time) for an agent event in the current turn. */
  agentEnvelopeOptions() {
    return this.turns.agentEnvelopeOptions();
  }

  map(event: ExtToBridge): OmpMappedEvent {
    switch (event.t) {
      case 'user':
        return { envelopes: event.text ? [createEnvelope('user', { t: 'text', text: event.text })] : [] };
      case 'assistant': {
        const envelopes: SessionEnvelope[] = [];
        if (event.thinking) {
          envelopes.push(...this.turns.mapMessage({ type: 'event', name: 'thinking', payload: { text: event.thinking, streaming: false } }));
        }
        if (event.text) {
          // omp reports whole messages; hold nothing back. A turn can stay open
          // for minutes (background jobs), so waiting for its end delays replies.
          envelopes.push(...this.turns.completeText(event.text));
        }
        return { envelopes };
      }
      case 'tool_start':
      case 'tool_update':
        return { envelopes: this.turns.toolCallStart(event.id, event.name, event.args, event.subtitle) };
      case 'tool_end':
        return { envelopes: this.turns.toolCallEnd(event.id, { isError: event.isError, ...(event.output !== undefined ? { result: event.output } : {}) }) };
      case 'status': {
        if (event.status === 'busy') {
          return { envelopes: this.turns.startTurn(), thinking: true };
        }
        const envelopes = event.error
          ? this.turns.mapMessage({ type: 'status', status: 'error', detail: event.error })
          : [];
        envelopes.push(...this.turns.endTurn(event.outcome ?? (event.error ? 'failed' : 'completed')));
        return { envelopes, thinking: false, turnEnded: true };
      }
      default:
        return { envelopes: [] };
    }
  }
}
