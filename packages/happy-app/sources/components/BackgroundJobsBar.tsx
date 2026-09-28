import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { sessionCancelBackgroundJob } from '@/sync/ops';
import { storage } from '@/sync/storage';
import type { BackgroundJob } from '@/sync/storageTypes';

const KIND_BY_TYPE: Record<string, string> = { task: 'subagent', bash: 'bash', eval: 'eval' };

function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "2 agents · 1 job", counting running jobs; "1 done" while only finished ones linger. */
function summarize(jobs: BackgroundJob[]): string {
    const running = jobs.filter((job) => job.status === 'running');
    const agents = running.filter((job) => job.type === 'task').length;
    const others = running.length - agents;
    const parts: string[] = [];
    if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
    if (others > 0) parts.push(`${others} job${others === 1 ? '' : 's'}`);
    const ended = jobs.length - running.length;
    if (ended > 0) parts.push(`${ended} done`);
    return parts.join(' · ');
}

/** Re-renders every second while `active`, so elapsed times tick. */
function useNow(active: boolean): number {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

/**
 * The agent's background work above the composer (omp async subagents and
 * backgrounded shells): a one-line count that expands into one row per job,
 * each with its own Stop. Tapping a row opens the tool card that started it.
 */
export const BackgroundJobsBar = React.memo(function BackgroundJobsBar(props: { sessionId: string; jobs: BackgroundJob[] }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [expanded, setExpanded] = React.useState(false);
    const [stopping, setStopping] = React.useState<ReadonlySet<string>>(new Set());
    const anyRunning = props.jobs.some((job) => job.status === 'running');
    const now = useNow(expanded && anyRunning);

    const openCard = React.useCallback((job: BackgroundJob) => {
        if (!job.callId) return;
        const messages = storage.getState().sessionMessages[props.sessionId]?.messages ?? [];
        const card = messages.find((message) => message.kind === 'tool-call' && message.tool.callId === job.callId);
        if (card) router.push(`/session/${props.sessionId}/message/${card.id}`);
    }, [props.sessionId, router]);

    const stop = React.useCallback((jobId: string) => {
        setStopping((current) => new Set(current).add(jobId));
        sessionCancelBackgroundJob(props.sessionId, jobId).catch(() => {
            setStopping((current) => {
                const next = new Set(current);
                next.delete(jobId);
                return next;
            });
        });
    }, [props.sessionId]);

    if (props.jobs.length === 0) return null;
    const secondary = { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() };

    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`Background work: ${summarize(props.jobs)}`}
                onPress={() => setExpanded((value) => !value)}
                hitSlop={6}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}
            >
                <Ionicons
                    name={anyRunning ? 'hourglass-outline' : 'checkmark-done-outline'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
                <Text style={secondary}>{summarize(props.jobs)}</Text>
                <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.colors.textSecondary} />
            </Pressable>
            {expanded && props.jobs.map((job) => {
                const running = job.status === 'running';
                const elapsed = formatElapsed((job.endTime ?? now) - job.startTime);
                const state = running ? (job.queued ? 'queued' : elapsed) : `${job.status === 'completed' ? 'done' : job.status} · ${elapsed}`;
                return (
                    <View key={job.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                        {running ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ transform: [{ scale: 0.7 }] }} />
                        ) : (
                            <Ionicons
                                name={job.status === 'completed' ? 'checkmark-circle' : 'close-circle'}
                                size={16}
                                color={job.status === 'completed' ? theme.colors.success : theme.colors.textDestructive}
                            />
                        )}
                        <Pressable
                            onPress={() => openCard(job)}
                            disabled={!job.callId}
                            style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}
                        >
                            <Text style={{ fontSize: 13, color: theme.colors.text, flexShrink: 1, ...Typography.default() }} numberOfLines={1}>
                                {job.label}
                            </Text>
                            <Text style={secondary} numberOfLines={1}>
                                {KIND_BY_TYPE[job.type] ?? job.type} · {state}
                            </Text>
                        </Pressable>
                        {running && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Stop ${job.label}`}
                                disabled={stopping.has(job.id)}
                                onPress={() => stop(job.id)}
                                hitSlop={8}
                                style={({ pressed }) => ({
                                    width: 28,
                                    height: 28,
                                    borderRadius: 14,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                    opacity: stopping.has(job.id) ? 0.5 : 1,
                                })}
                            >
                                <Ionicons name="stop-circle-outline" size={18} color={theme.colors.textDestructive} />
                            </Pressable>
                        )}
                    </View>
                );
            })}
        </View>
    );
});
