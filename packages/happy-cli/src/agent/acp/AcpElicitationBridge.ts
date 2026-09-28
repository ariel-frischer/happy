/**
 * Bridges ACP `elicitation/create` requests to the Happy app.
 *
 * Each request is published as a `form` communication in AgentState (see
 * {@link FormCommunicationBridge}); pending requests resolve with `cancel` on
 * abort, session end, or when the app dismisses them, so the agent is never
 * left waiting.
 */

import type { ApiSessionClient } from '@/api/apiSession';
import { FormCommunicationBridge } from '@/agent/formCommunicationBridge';
import { logger } from '@/ui/logger';
import {
  CANCELLED_ELICITATION,
  answersToElicitationResponse,
  elicitationToForm,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from './elicitationForm';

export class AcpElicitationBridge {
  private readonly forms: FormCommunicationBridge;

  constructor(session: ApiSessionClient, private readonly logPrefix: string) {
    this.forms = new FormCommunicationBridge(session, logPrefix);
  }

  /** Re-binds the RPC handler after offline reconnection swaps sessions. */
  updateSession(session: ApiSessionClient): void {
    this.forms.updateSession(session);
  }

  /** Publishes the elicitation to the app and waits for the user's reply. */
  async request(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const form = elicitationToForm(params);
    if (!form) {
      logger.debug(`${this.logPrefix} Declining elicitation the app cannot render`, JSON.stringify(params));
      return { action: 'decline' };
    }
    const reply = await this.forms.open({ title: form.title, questions: form.questions });
    return reply.status === 'answered' ? answersToElicitationResponse(form, reply.answers) : CANCELLED_ELICITATION;
  }

  /** Resolves every pending elicitation with `cancel` and clears all open communications. */
  cancelAll(reason: string): void {
    this.forms.cancelAll(reason);
  }
}
