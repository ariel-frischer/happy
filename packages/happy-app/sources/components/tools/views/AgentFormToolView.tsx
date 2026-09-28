import * as React from 'react';

import { useSessionAgentFormCommunication } from '@/sync/storage';
import { ToolViewProps } from './_all';
import { AnsweredQuestions } from './InlineQuestionForm';

/**
 * Tool card body for a tool that raised an agent form (Codex/Happy
 * request_user_input, omp ask, an ACP tool that elicited input). While the
 * form is pending it is answered from the card at the end of the chat
 * (PendingAgentQuestions), so the question stays in view below the newest
 * message; once it settles, from the app or from the terminal, this card
 * keeps every question and its answer read-only in the transcript.
 */
export const AgentFormToolView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');
    if (!communication || communication.status === 'pending') return null;

    return (
        <AnsweredQuestions
            questions={communication.questions}
            answers={communication.status === 'cancelled' ? null : (communication.answers ?? {})}
        />
    );
});
