import * as React from 'react';

import { useSessionAgentFormCommunication } from '@/sync/storage';
import { ToolViewProps } from './_all';
import { InlineQuestionForm } from './InlineQuestionForm';

const noopSubmit = async () => {};

/**
 * Tool card body for tools that raise an agent form (Codex/Happy
 * request_user_input, omp ask). While the form is pending it is answered from
 * the card at the end of the chat (PendingAgentQuestions), so the question
 * stays in view below the newest message; once it settles, from the app or
 * from the terminal, this card keeps the answers read-only in the transcript.
 */
export const AgentFormToolView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');
    if (!communication || communication.status === 'pending') return null;

    return (
        <InlineQuestionForm
            questions={communication.questions}
            canInteract={false}
            submittedAnswers={communication.answers ?? {}}
            onSubmit={noopSubmit}
        />
    );
});
