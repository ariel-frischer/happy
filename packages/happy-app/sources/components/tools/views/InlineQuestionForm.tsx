import * as React from 'react';
import { ActivityIndicator, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import {
    acceptsWrittenAnswer,
    buildAnswers,
    canSubmit,
    EMPTY_DRAFT,
    toggleOption,
    type AgentQuestionDraft,
} from '@/sync/agentCommunications';
import type { AgentQuestion, AgentQuestionAnswer } from '@/sync/storageTypes';
import { ToolSectionView } from '../ToolSectionView';

export type InlineQuestion = AgentQuestion;

export type InlineQuestionAnswers = Record<string, AgentQuestionAnswer>;

interface InlineQuestionFormProps {
    questions: InlineQuestion[];
    canInteract: boolean;
    submittedAnswers?: InlineQuestionAnswers | null;
    onSubmit: (answers: InlineQuestionAnswers) => Promise<void>;
    /** Shows a Dismiss button that declines the whole request. */
    onDismiss?: () => Promise<void>;
}

// This is the shared question form used by Claude's AskUserQuestion tool and by
// agent communications (Codex/Happy request_user_input, ACP elicitation, omp
// ask). Every question is visible and editable until Submit; a question that
// accepts a written answer also gets a text field. Transport and answer
// payload differences stay in the small wrappers around this view.
export const InlineQuestionForm = React.memo<InlineQuestionFormProps>((props) => {
    const { questions, onSubmit, onDismiss } = props;
    const { theme } = useUnistyles();
    const [drafts, setDrafts] = React.useState<Record<string, AgentQuestionDraft>>({});
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [locallySubmittedAnswers, setLocallySubmittedAnswers] = React.useState<InlineQuestionAnswers | null>(null);
    const questionKey = questions.map(question => question.id).join('\u0000');

    React.useEffect(() => {
        setDrafts({});
        setLocallySubmittedAnswers(null);
        setIsSubmitting(false);
        setError(null);
    }, [questionKey]);

    const submittedAnswers = props.submittedAnswers ?? locallySubmittedAnswers;
    const canInteract = props.canInteract && submittedAnswers === null && !isSubmitting;
    const ready = canSubmit(questions, drafts);

    const handleOptionToggle = React.useCallback((question: InlineQuestion, label: string) => {
        if (!canInteract) return;
        setDrafts(previous => ({
            ...previous,
            [question.id]: toggleOption(previous[question.id] ?? EMPTY_DRAFT, label, question.multiSelect === true),
        }));
    }, [canInteract]);

    const handleCustomChange = React.useCallback((questionId: string, custom: string) => {
        setDrafts(previous => ({
            ...previous,
            [questionId]: { ...(previous[questionId] ?? EMPTY_DRAFT), custom },
        }));
    }, []);

    const handleSubmit = React.useCallback(async () => {
        if (!ready || isSubmitting) return;

        const answers = buildAnswers(questions, drafts);
        setIsSubmitting(true);
        setError(null);
        setLocallySubmittedAnswers(answers);
        try {
            await onSubmit(answers);
        } catch (submitError) {
            // Put the form back with the drafts intact so the user can retry.
            setLocallySubmittedAnswers(null);
            setError(submitError instanceof Error ? submitError.message : t('agentQuestion.submitFailed'));
        } finally {
            setIsSubmitting(false);
        }
    }, [drafts, isSubmitting, onSubmit, questions, ready]);

    const handleDismiss = React.useCallback(async () => {
        if (!onDismiss || isSubmitting) return;
        setIsSubmitting(true);
        setError(null);
        try {
            await onDismiss();
        } catch (dismissError) {
            setError(dismissError instanceof Error ? dismissError.message : t('agentQuestion.submitFailed'));
        } finally {
            setIsSubmitting(false);
        }
    }, [isSubmitting, onDismiss]);

    if (submittedAnswers) {
        return <AnsweredQuestions questions={questions} answers={submittedAnswers} />;
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {questions.map(question => {
                    const draft = drafts[question.id] ?? EMPTY_DRAFT;
                    return (
                        <View key={question.id} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            {question.options.length > 0 && (
                                <View style={styles.optionsContainer}>
                                    {question.options.map((option, optionIndex) => {
                                        const isSelected = draft.options.includes(option.label);
                                        return (
                                            <TouchableOpacity
                                                key={`${question.id}:${optionIndex}`}
                                                style={[
                                                    styles.optionButton,
                                                    isSelected && styles.optionButtonSelected,
                                                    !canInteract && styles.optionButtonDisabled,
                                                ]}
                                                onPress={() => handleOptionToggle(question, option.label)}
                                                disabled={!canInteract}
                                                activeOpacity={0.7}
                                            >
                                                {question.multiSelect ? (
                                                    <View style={[
                                                        styles.checkboxOuter,
                                                        isSelected && styles.checkboxOuterSelected,
                                                    ]}>
                                                        {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                                                    </View>
                                                ) : (
                                                    <View style={[
                                                        styles.radioOuter,
                                                        isSelected && styles.radioOuterSelected,
                                                    ]}>
                                                        {isSelected && <View style={styles.radioInner} />}
                                                    </View>
                                                )}
                                                <View style={styles.optionContent}>
                                                    <Text style={styles.optionLabel}>{option.label}</Text>
                                                    {option.description ? (
                                                        <Text style={styles.optionDescription}>{option.description}</Text>
                                                    ) : null}
                                                </View>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            )}
                            {acceptsWrittenAnswer(question) && (
                                <TextInput
                                    style={[styles.customInput, !canInteract && styles.optionButtonDisabled]}
                                    value={draft.custom}
                                    onChangeText={value => handleCustomChange(question.id, value)}
                                    placeholder={question.options.length > 0
                                        ? t('agentQuestion.ownAnswerPlaceholder')
                                        : t('agentQuestion.ownAnswer')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    multiline
                                    editable={canInteract}
                                />
                            )}
                        </View>
                    );
                })}

                {error && <Text style={styles.errorText}>{error}</Text>}

                {props.canInteract && (
                    <View style={styles.actionsContainer}>
                        {onDismiss && (
                            <TouchableOpacity
                                style={[styles.dismissButton, isSubmitting && styles.submitButtonDisabled]}
                                onPress={handleDismiss}
                                disabled={isSubmitting}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.dismissButtonText}>{t('agentQuestion.dismiss')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                ready && !isSubmitting && styles.submitButtonReady,
                                (!ready || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!ready || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator
                                    size="small"
                                    color={Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text })}
                                />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});


/**
 * A settled form, read-only: every question with the answer given beneath it.
 * `answers === null` means the request was dismissed without an answer.
 */
export const AnsweredQuestions = React.memo((props: {
    questions: InlineQuestion[];
    answers: InlineQuestionAnswers | null;
}) => {
    const { theme } = useUnistyles();
    return (
        <ToolSectionView>
            <View style={styles.answeredContainer}>
                {props.questions.map(question => {
                    const answer = props.answers?.[question.id];
                    const custom = answer?.custom?.trim();
                    const hasAnswer = (answer?.options.length ?? 0) > 0 || Boolean(custom);
                    return (
                        <View key={question.id} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.answerList}>
                                {answer?.options.map(option => (
                                    <View key={option} style={styles.answerRow}>
                                        <Ionicons name="checkmark-circle" size={16} color={theme.colors.radio.active} style={styles.answerIcon} />
                                        <Text style={styles.answerText}>{option}</Text>
                                    </View>
                                ))}
                                {custom ? (
                                    <View style={styles.answerRow}>
                                        <Ionicons name="create-outline" size={16} color={theme.colors.textSecondary} style={styles.answerIcon} />
                                        <Text style={styles.answerCustomText}>{custom}</Text>
                                    </View>
                                ) : null}
                                {!hasAnswer && (
                                    <Text style={styles.answerEmptyText}>
                                        {props.answers === null ? t('agentQuestion.dismissed') : '—'}
                                    </Text>
                                )}
                            </View>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

// Kept visually identical to the existing AskUserQuestion experience.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44,
    },
    optionButtonSelected: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfaceHighest }),
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    customInput: {
        minHeight: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: theme.colors.text,
        textAlignVertical: 'top',
    },
    errorText: {
        fontSize: 13,
        color: theme.colors.warning,
    },
    dismissButton: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    dismissButtonText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        fontWeight: '600',
    },
    submitButton: {
        backgroundColor: Platform.select({ web: theme.colors.button.primary.background, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.select({ web: 0, default: 1 }),
        borderColor: theme.colors.divider,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonReady: {
        borderColor: theme.colors.radio.active,
    },
    submitButtonText: {
        color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }),
        fontSize: 14,
        fontWeight: '600',
    },
    answeredContainer: {
        gap: 16,
    },
    answerList: {
        gap: 4,
    },
    answerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    answerIcon: {
        marginTop: 1,
    },
    answerText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    answerCustomText: {
        flex: 1,
        fontSize: 14,
        fontStyle: 'italic',
        color: theme.colors.text,
    },
    answerEmptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
}));