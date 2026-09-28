import React from 'react';
import { ScrollView, View } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { PendingAgentQuestionCard } from '@/components/PendingAgentQuestions';
import { AnsweredQuestions } from '@/components/tools/views/InlineQuestionForm';
import type { PendingAgentForm, PendingUnsupportedCommunication } from '@/sync/agentCommunications';

const formCommunication: PendingAgentForm = {
    id: 'demo-form',
    createdAt: 0,
    kind: 'form',
    questions: [
        {
            id: 'q1',
            header: 'Storage',
            question: 'Where should the project order live?',
            multiSelect: false,
            allowCustom: true,
            options: [
                { label: 'In settings', description: 'Synced to every device you sign in from' },
                { label: 'On this device', description: 'Stays local, never leaves the phone' },
            ],
        },
        {
            id: 'q2',
            header: 'Scope',
            question: 'Which surfaces should it apply to?',
            multiSelect: true,
            options: [
                { label: 'Mobile', description: 'The phone session list' },
                { label: 'Tablet sidebar', description: 'The split-view sidebar' },
                { label: 'Desktop', description: 'The Tauri app' },
            ],
        },
    ],
};

const unsupportedCommunication: PendingUnsupportedCommunication = {
    id: 'demo-unsupported',
    createdAt: 0,
    kind: 'unsupported',
    rawKind: 'file_pick',
    title: 'Choose a file to review',
};

export default function AgentQuestionDemoScreen() {
    const styles = stylesheet;

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Agent Questions' }} />
            <ScrollView style={styles.container} contentContainerStyle={styles.content}>
                <Text style={styles.description}>
                    Agent-to-user communications, as they render at the end of the chat. A form is
                    answered in place; a kind this build does not implement says so and offers to
                    dismiss it.
                </Text>

                <ItemGroup title="Form">
                    <PendingAgentQuestionCard sessionId="demo-session" pending={formCommunication} />
                </ItemGroup>

                <ItemGroup title="Answered (tool card)">
                    <View style={styles.answered}>
                        <AnsweredQuestions
                            questions={formCommunication.questions}
                            answers={{
                                q1: { options: [], custom: 'In a dotfile next to the repo' },
                                q2: { options: ['Mobile', 'Desktop'] },
                            }}
                        />
                    </View>
                </ItemGroup>

                <ItemGroup title="Dismissed (tool card)">
                    <View style={styles.answered}>
                        <AnsweredQuestions questions={formCommunication.questions} answers={null} />
                    </View>
                </ItemGroup>

                <ItemGroup title="Unsupported kind">
                    <PendingAgentQuestionCard sessionId="demo-session" pending={unsupportedCommunication} />
                </ItemGroup>
            </ScrollView>
        </>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        paddingVertical: 16,
        gap: 8,
    },
    description: {
        paddingHorizontal: 20,
        paddingBottom: 8,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    answered: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
}));
