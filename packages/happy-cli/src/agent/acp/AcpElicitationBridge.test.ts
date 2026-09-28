import { describe, expect, it } from 'vitest';

import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, SessionCommunicationReply } from '@/api/types';
import { AcpElicitationBridge } from './AcpElicitationBridge';
import type { CreateElicitationRequest } from './elicitationForm';

/** Minimal session: keeps agent state in memory and exposes registered RPC handlers. */
function fakeSession() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const session = {
    state: {} as AgentState,
    rpcHandlerManager: {
      registerHandler: (method: string, handler: (payload: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    },
    updateAgentState(handler: (state: AgentState) => AgentState) {
      session.state = handler(session.state);
    },
    reply: (payload: SessionCommunicationReply) => handlers.get('communication')!(payload),
  };
  return session;
}

const ask: CreateElicitationRequest = {
  mode: 'form',
  sessionId: 's1',
  message: 'Which database?',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: { type: 'string', title: 'Which database?', oneOf: [{ const: 'Postgres', title: 'Postgres' }] },
      q0__other: { type: 'string', title: 'Other (type your own)' },
    },
  },
};

function setup() {
  const session = fakeSession();
  const bridge = new AcpElicitationBridge(session as unknown as ApiSessionClient, '[test]');
  return { session, bridge };
}

describe('AcpElicitationBridge', () => {
  it('publishes a form communication and returns the answer to the agent', async () => {
    const { session, bridge } = setup();
    const response = bridge.request(ask);

    const [id, communication] = Object.entries(session.state.communications ?? {})[0];
    expect(communication).toMatchObject({ kind: 'form', form: { questions: [{ id: 'q0', allowCustom: true }] } });

    await session.reply({ id, kind: 'form', status: 'answered', answers: { q0: { options: [], custom: 'MySQL' } } });

    await expect(response).resolves.toEqual({ action: 'accept', content: { q0__other: 'MySQL' } });
    expect(session.state.communications).toEqual({});
    expect(session.state.completedCommunications?.[id]).toMatchObject({
      status: 'answered',
      answers: { q0: { options: [], custom: 'MySQL' } },
    });
  });

  it('cancels the elicitation when the app dismisses it', async () => {
    const { session, bridge } = setup();
    const response = bridge.request(ask);
    const id = Object.keys(session.state.communications ?? {})[0];

    await session.reply({ id, kind: 'form', status: 'cancelled' });

    await expect(response).resolves.toEqual({ action: 'cancel' });
    expect(session.state.completedCommunications?.[id]?.status).toBe('cancelled');
  });

  it('cancels every pending elicitation on abort and clears them from the app', async () => {
    const { session, bridge } = setup();
    const first = bridge.request(ask);
    const second = bridge.request(ask);

    bridge.cancelAll('Aborted by user');

    await expect(first).resolves.toEqual({ action: 'cancel' });
    await expect(second).resolves.toEqual({ action: 'cancel' });
    expect(session.state.communications).toEqual({});
    expect(Object.values(session.state.completedCommunications ?? {}).map((c) => c.status))
      .toEqual(['cancelled', 'cancelled']);
  });

  it('declines requests the app cannot render without publishing anything', async () => {
    const { session, bridge } = setup();
    await expect(bridge.request({ mode: 'url', message: 'Sign in' })).resolves.toEqual({ action: 'decline' });
    expect(session.state.communications).toBeUndefined();
  });
});
