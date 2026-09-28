import { describe, it, expect, beforeEach, vi } from 'vitest';

// react-native-mmkv needs a native/web backend; back it with a plain in-memory map.
const store = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
        getNumber(key: string) { const v = store.get(key); return v === undefined ? undefined : Number(v); }
        clearAll() { store.clear(); }
    },
}));

const { loadNewSessionDraft, loadPendingSettings, savePendingSettings } = await import('./persistence');

describe('loadNewSessionDraft harness', () => {
    beforeEach(() => store.clear());

    function loadWith(fields: Record<string, unknown>) {
        store.set('new-session-draft-v1', JSON.stringify({ input: '', updatedAt: 1, ...fields }));
        return loadNewSessionDraft();
    }

    it('keeps a harness a person picked', () => {
        expect(loadWith({ agentType: 'claude', agentTypeChosen: true })).toMatchObject({ agentType: 'claude', agentTypeChosen: true });
        expect(loadWith({ agentType: 'omp', agentTypeChosen: true })).toMatchObject({ agentType: 'omp', agentTypeChosen: true });
    });

    it('starts from omp when the app picked the saved harness', () => {
        expect(loadWith({ agentType: 'codex', agentTypeChosen: false })).toMatchObject({ agentType: 'omp', agentTypeChosen: false });
    });

    it('treats a legacy Claude draft as the old default, but a legacy other harness as a choice', () => {
        expect(loadWith({ agentType: 'claude' })).toMatchObject({ agentType: 'omp', agentTypeChosen: false });
        expect(loadWith({ agentType: 'codex' })).toMatchObject({ agentType: 'codex', agentTypeChosen: true });
    });

    it('falls back to omp for an unknown harness', () => {
        expect(loadWith({ agentType: 'mystery', agentTypeChosen: true })).toMatchObject({ agentType: 'omp', agentTypeChosen: false });
    });
});

describe('loadPendingSettings', () => {
    beforeEach(() => store.clear());

    it('returns nothing pending for an empty queue', () => {
        // Regression: `SettingsSchema.partial().parse({})` re-injects the fields that
        // carry a zod `.default()`, so an empty queue used to come back as
        // "reset schemaVersion / agentDefaultOverrides / dismissedCLIWarnings".
        // That delta then overwrote real settings locally and on the server, which
        // reset the agent model default on every refresh.
        savePendingSettings({});
        expect(loadPendingSettings()).toEqual({});
    });

    it('keeps only the keys that were actually queued', () => {
        savePendingSettings({ viewInline: true });
        expect(loadPendingSettings()).toEqual({ viewInline: true });
    });

    it('preserves a genuinely queued agentDefaultOverrides value', () => {
        savePendingSettings({ agentDefaultOverrides: { claude: { modelMode: 'claude-opus-5' } } });
        expect(loadPendingSettings()).toEqual({
            agentDefaultOverrides: { claude: { modelMode: 'claude-opus-5' } },
        });
    });

    it('keeps a deliberate reset to empty overrides', () => {
        savePendingSettings({ agentDefaultOverrides: {} });
        expect(loadPendingSettings()).toEqual({ agentDefaultOverrides: {} });
    });

    it('falls back to an empty queue on malformed json', () => {
        store.set('pending-settings', '{not json');
        expect(loadPendingSettings()).toEqual({});
    });
});
