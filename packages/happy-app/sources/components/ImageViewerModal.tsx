/**
 * Fullscreen image viewer. Closes via the close button, Android back, or
 * Escape on web (react-native-web's Modal routes Escape to onRequestClose).
 * Pinch to zoom, drag while zoomed, double-tap to toggle zoom.
 */
import * as React from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

interface ImageViewerModalProps {
    uri: string | null;
    visible: boolean;
    onClose: () => void;
}

export const ImageViewerModal = React.memo<ImageViewerModalProps>(({ uri, visible, onClose }) => {
    return (
        <Modal
            visible={visible && !!uri}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={onClose}
        >
            {/* Modal content lives outside the app root on Android, so gestures need their own root. */}
            <GestureHandlerRootView style={styles.root}>
                {uri ? <ZoomableImage uri={uri} /> : null}
                <CloseButton onClose={onClose} />
            </GestureHandlerRootView>
        </Modal>
    );
});

function CloseButton({ onClose }: { onClose: () => void }) {
    const insets = useSafeAreaInsets();
    return (
        <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={[styles.closeButton, { top: insets.top + 12, right: insets.right + 12 }]}
        >
            <Ionicons name="close" size={24} color="#FFFFFF" />
        </Pressable>
    );
}

function ZoomableImage({ uri }: { uri: string }) {
    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const savedTranslateX = useSharedValue(0);
    const savedTranslateY = useSharedValue(0);

    const reset = () => {
        'worklet';
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
    };

    const pinch = Gesture.Pinch()
        .onUpdate((e) => {
            scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE * 0.5, savedScale.value * e.scale));
        })
        .onEnd(() => {
            if (scale.value <= MIN_SCALE) {
                reset();
            } else {
                savedScale.value = scale.value;
            }
        });

    const pan = Gesture.Pan()
        .averageTouches(true)
        .onUpdate((e) => {
            if (savedScale.value <= MIN_SCALE) return;
            translateX.value = savedTranslateX.value + e.translationX;
            translateY.value = savedTranslateY.value + e.translationY;
        })
        .onEnd(() => {
            savedTranslateX.value = translateX.value;
            savedTranslateY.value = translateY.value;
        });

    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (savedScale.value > MIN_SCALE) {
                reset();
            } else {
                scale.value = withTiming(DOUBLE_TAP_SCALE);
                savedScale.value = DOUBLE_TAP_SCALE;
            }
        });

    const gesture = Gesture.Simultaneous(pinch, pan, doubleTap);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: scale.value },
        ],
    }));

    return (
        <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.imageContainer, animatedStyle]}>
                <Image source={{ uri }} style={styles.image} contentFit="contain" />
            </Animated.View>
        </GestureDetector>
    );
}

// Plain RN styles: unistyles does not reach GestureHandlerRootView on web, which left
// the viewer with no size or backdrop.
const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
    },
    imageContainer: {
        flex: 1,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    closeButton: {
        position: 'absolute',
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
    },
});
