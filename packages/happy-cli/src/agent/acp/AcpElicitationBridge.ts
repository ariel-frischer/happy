/**
 * Bridges ACP `elicitation/create` requests to the Happy app.
 *
 * Each request is published as a `form` communication in AgentState; the app
 * answers or dismisses it through the `communication` session RPC. Pending
 * requests resolve with `cancel` on abort, session end, or when the app
 * dismisses them, so the agent is never left waiting.
 */

import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentCommunication, AgentQuestionAnswer, AgentState, SessionCommunicationReply } from '@/api/types';
import { logger } from '@/ui/logger';
import {
  CANCELLED_ELICITATION,
  answersToElicitationResponse,
  elicitationToForm,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationForm,
} from './elicitationForm';

type PendingElicitation = {
  form: ElicitationForm;
  resolve: (response: CreateElicitationResponse) => void;
};

export class AcpElicitationBridge {
  private readonly pending = new Map<string, PendingElicitation>();
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

  /** Publishes the elicitation to the app and waits for the user's reply. */
  request(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const form = elicitationToForm(params);
    if (!form) {
      logger.debug(`${this.logPrefix} Declining elicitation the app cannot render`, JSON.stringify(params));
      return Promise.resolve({ action: 'decline' });
    }

    const id = randomUUID();
    const communication: AgentCommunication = {
      kind: 'form',
      createdAt: Date.now(),
      title: form.title,
      form: { questions: form.questions },
    };
    return new Promise<CreateElicitationResponse>((resolve) => {
      this.pending.set(id, { form, resolve });
      this.session.updateAgentState((state) => ({
        ...state,
        communications: { ...state.communications, [id]: communication },
      }));
      logger.debug(`${this.logPrefix} Elicitation ${id} sent with ${form.questions.length} question(s)`);
    });
  }

  /** Resolves every pending elicitation with `cancel` and clears all open communications. */
  cancelAll(reason: string): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pending) {
      entry.resolve(CANCELLED_ELICITATION);
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
      logger.debug(`${this.logPrefix} Cancelled ${pending.length} pending elicitation(s): ${reason}`);
    }
  }

  private registerRpcHandler(): void {
    this.session.rpcHandlerManager.registerHandler<SessionCommunicationReply, void>('communication', async (reply) => {
      const entry = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      const answered = reply.status === 'answered';
      entry?.resolve(answered ? answersToElicitationResponse(entry.form, reply.answers) : CANCELLED_ELICITATION);
      // Also clears communications this process no longer tracks (left by a
      // CLI process that died), so the app does not keep showing them.
      this.session.updateAgentState((state) => completeCommunication(
        state,
        reply.id,
        answered ? 'answered' : 'cancelled',
        answered ? reply.answers : undefined,
      ));
      logger.debug(`${this.logPrefix} Elicitation ${reply.id} ${reply.status}${entry ? '' : ' (not pending)'}`);
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
