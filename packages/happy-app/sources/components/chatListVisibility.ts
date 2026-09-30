import * as React from 'react';
import type { TextInput } from 'react-native';

/**
 * Keeps a text field that lives inside the inverted chat list on screen while
 * it is edited.
 *
 * The list is inverted with transforms (rotate 180° on Android), and Android's
 * native "bring the focused field / caret into view" scrolling computes the
 * field's position without those transforms. Together with the list anchoring
 * history rows while the field grows, typing in an inline answer can scroll
 * the field under the keyboard and composer. Rather than trusting the native
 * scroll, the list measures where the field actually is on screen and moves
 * it back into the visible band.
 *
 * `keepVisible(field)` marks the focused field and reveals it; the list also
 * re-reveals it when its insets change (keyboard, composer). `keepVisible(null)`
 * releases it on blur.
 */
export type KeepVisibleInChatList = (field: TextInput | null) => void;

export const ChatListVisibilityContext = React.createContext<KeepVisibleInChatList | null>(null);

type WindowRect = { y: number; height: number };

/** Gap kept between the field and the edge of the visible band. */
const REVEAL_MARGIN = 12;

/**
 * The scroll offset that brings `field` into the list's visible band, or null
 * when it is already visible. Offsets follow the inverted list: offset 0 is the
 * newest message, and a larger offset moves content down the screen. When the
 * field is taller than the band, its bottom edge (where typing happens) wins.
 */
export function offsetRevealingField(params: {
    list: WindowRect;
    field: WindowRect;
    /** Screen covered at the list's top edge (header overlay). */
    topInset: number;
    /** Screen covered at the list's bottom edge (composer, keyboard, safe area). */
    bottomInset: number;
    offset: number;
}): number | null {
    const { list, field, topInset, bottomInset, offset } = params;
    const visibleTop = list.y + topInset + REVEAL_MARGIN;
    const visibleBottom = list.y + list.height - bottomInset - REVEAL_MARGIN;
    const belowBy = field.y + field.height - visibleBottom;
    if (belowBy > 0) {
        return Math.max(0, offset - belowBy);
    }
    const aboveBy = visibleTop - field.y;
    if (aboveBy > 0) {
        return offset + aboveBy;
    }
    return null;
}

/**
 * `reveal` for a TextInput rendered inside the chat list, to call on focus,
 * edits, and growth; `release` on blur. Outside a chat list (dev previews)
 * both do nothing.
 */
export function useKeepVisibleInChatList() {
    const keepVisible = React.useContext(ChatListVisibilityContext);
    const ref = React.useRef<TextInput>(null);
    const reveal = React.useCallback(() => {
        const field = ref.current;
        if (keepVisible && field?.isFocused()) keepVisible(field);
    }, [keepVisible]);
    const release = React.useCallback(() => keepVisible?.(null), [keepVisible]);
    return { ref, reveal, release };
}
