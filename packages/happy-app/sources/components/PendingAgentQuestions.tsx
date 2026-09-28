import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { InlineQuestionForm, type InlineQuestionAnswers } from '@/components/tools/views/InlineQuestionForm';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionPendingCommunications } from '@/sync/storage';
import type { PendingAgentCommunication, PendingAgentForm } from '@/sync/agentCommunications';
import { sessionAnswerQuestion, sessionCancelCommunication } from '@/sync/ops';
import { layout } from './layout';

/**
 * Everything the agent is waiting on, as chat cards directly below the newest
 * message. This is the only place a pending communication is answered: it
 * lives in the transcript, so it is on screen when the session opens and
 * cannot be closed away while the agent still waits. Once a form settles, the
 * tool card that raised it (AgentFormToolView) keeps the answers read-only.
 */
export const PendingAgentQuestions = React.memo(({ sessionId }: { sessionId: string }) => {
    const pending = useSessionPendingCommunications(sessionId);
    if (pending.length === 0) return null;
    return (
        <>
            {pending.map(communication => (
                <PendingAgentQuestionCard key={communication.id} sessionId={sessionId} pending={communication} />
            ))}
        </>
    );
});

/**
 * One pending communication, with no store of its own, so the dev preview can
 * render it too. `sessionId` is only used to send the answer or dismissal.
 */
export function PendingAgentQuestionCard({ sessionId, pending }: {
    sessionId: string;
    pending: PendingAgentCommunication;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const dismiss = React.useCallback(
        () => sessionCancelCommunication(sessionId, pending.id, pending.kind === 'form' ? pending.kind : pending.rawKind),
        [pending, sessionId],
    );

    return (
        <View style={styles.row}>
            <View style={styles.column}>
                <View style={styles.card}>
                    <View style={styles.header}>
                        <Ionicons
                            name={pending.kind === 'form' ? 'help-circle-outline' : 'alert-circle-outline'}
                            size={18}
                            color={pending.kind === 'form' ? theme.colors.textLink : theme.colors.textSecondary}
                        />
                        <Text style={styles.title} numberOfLines={1}>
                            {pending.kind === 'form'
                                ? t('agentQuestion.title')
                                : (pending.title ?? t('agentQuestion.unsupportedTitle'))}
                        </Text>
                    </View>
                    <View style={styles.content}>
                        {pending.kind === 'form' ? (
                            <PendingFormBody sessionId={sessionId} pending={pending} onDismiss={dismiss} />
                        ) : (
                            <View style={styles.unsupported}>
                                <Text style={styles.unsupportedText}>
                                    {t('agentQuestion.unsupportedDescription', { kind: pending.rawKind })}
                                </Text>
                                <Pressable onPress={() => { void dismiss().catch(() => {}); }} hitSlop={10}>
                                    <Text style={styles.dismiss}>{t('agentQuestion.dismiss')}</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                </View>
            </View>
        </View>
    );
}

function PendingFormBody({ sessionId, pending, onDismiss }: {
    sessionId: string;
    pending: PendingAgentForm;
    onDismiss: () => Promise<void>;
}) {
    const handleSubmit = React.useCallback(
        (answers: InlineQuestionAnswers) => sessionAnswerQuestion(sessionId, pending.id, answers, pending.kind),
        [pending.id, pending.kind, sessionId],
    );
    return (
        <InlineQuestionForm
            questions={pending.questions}
            canInteract
            onSubmit={handleSubmit}
            onDismiss={onDismiss}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    column: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        paddingHorizontal: 8,
    },
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.textLink,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    title: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    unsupported: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingBottom: 12,
    },
    unsupportedText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    dismiss: {
        fontSize: 14,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));
