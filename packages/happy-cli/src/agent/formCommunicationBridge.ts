/**
 * Publishes question forms to the Happy app as AgentState `form`
 * communications and collects the app's reply through the `communication`
 * session RPC. Shared by ACP elicitations and omp `ask` dialogs.
 */

import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentCommunication, AgentQuestion, AgentQuestionAnswer, AgentState, SessionCommunicationReply } from '@/api/types';
import { logger } from '@/ui/logger';

export type FormReply =
  | { status: 'answered'; answers: Record<string, AgentQuestionAnswer> }
  | { status: 'cancelled' };

export type FormRequest = {
  title: string;
  questions: AgentQuestion[];
  /** Tool call that raised the form, so the app can join them. */
  toolUseId?: string;
};

const CANCELLED: FormReply = { status: 'cancelled' };

export class FormCommunicationBridge {
  private readonly pending = new Map<string, (reply: FormReply) => void>();
  private session: ApiSessionClient;

  constructor(session: ApiSessionClient, private readonly logPrefix: string) {
    this.session = session;
    this.registerRpcHandler();
  }

  /** Re-binds the RPC handler after offline reconnection swaps sessions. */
  updateSession(session: ApiSessionClient): void {
    this.session = session;
    this.registerRpcHandler();
  }

  /** Shows the form in the app; resolves with the app's reply or `cancelled`. */
  open(request: FormRequest, id: string = randomUUID()): Promise<FormReply> {
    const communication: AgentCommunication = {
      kind: 'form',
      createdAt: Date.now(),
      title: request.title,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      form: { questions: request.questions },
    };
    return new Promise<FormReply>((resolve) => {
      this.pending.set(id, resolve);
      this.session.updateAgentState((state) => ({
        ...state,
        communications: { ...state.communications, [id]: communication },
      }));
      logger.debug(`${this.logPrefix} Form ${id} sent with ${request.questions.length} question(s)`);
    });
  }

  /**
   * Closes one form from the agent side (answered elsewhere, or no longer
   * needed). Its pending promise resolves `cancelled`; the app sees the form
   * completed with `answers` when given, else cancelled.
   */
  close(id: string, answers?: Record<string, AgentQuestionAnswer>): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(CANCELLED);
    this.session.updateAgentState((state) => completeCommunication(
      state,
      id,
      answers ? 'answered' : 'cancelled',
      answers,
    ));
  }

  /** Resolves every pending form with `cancelled` and clears all open communications. */
  cancelAll(reason: string): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const resolve of pending) {
      resolve(CANCELLED);
    }
    this.session.updateAgentState((state) => {
      const ids = Object.keys(state.communications ?? {});
      if (ids.length === 0) return state;
      let next = state;
      for (const id of ids) {
        next = completeCommunication(next, id, 'cancelled');
      }
      return next;
    });
    if (pending.length > 0) {
      logger.debug(`${this.logPrefix} Cancelled ${pending.length} pending form(s): ${reason}`);
    }
  }

  private registerRpcHandler(): void {
    this.session.rpcHandlerManager.registerHandler<SessionCommunicationReply, void>('communication', async (reply) => {
      const resolve = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      const answered = reply.status === 'answered';
      resolve?.(answered ? { status: 'answered', answers: reply.answers ?? {} } : CANCELLED);
      // Also clears communications this process no longer tracks (left by a
      // CLI process that died), so the app does not keep showing them.
      this.session.updateAgentState((state) => completeCommunication(
        state,
        reply.id,
        answered ? 'answered' : 'cancelled',
        answered ? reply.answers : undefined,
      ));
      logger.debug(`${this.logPrefix} Form ${reply.id} ${reply.status}${resolve ? '' : ' (not pending)'}`);
    });
  }
}

function completeCommunication(
  state: AgentState,
  id: string,
  status: 'answered' | 'cancelled',
  answers?: Record<string, AgentQuestionAnswer>,
): AgentState {
  const communication = state.communications?.[id];
  if (!communication) return state;
  const { [id]: _, ...remaining } = state.communications ?? {};
  return {
    ...state,
    communications: remaining,
    completedCommunications: {
      ...state.completedCommunications,
      [id]: { ...communication, completedAt: Date.now(), status, ...(answers ? { answers } : {}) },
    },
  };
}
