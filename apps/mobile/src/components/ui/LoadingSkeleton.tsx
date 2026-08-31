import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, type ViewStyle } from 'react-native';
import { color, radius } from '@/theme/tokens';

type Variant = 'card' | 'row' | 'chart';

interface Props {
  variant?: Variant;
  height?: number;
  style?: ViewStyle;
}

const DEFAULT_HEIGHT: Record<Variant, number> = { card: 96, row: 16, chart: 160 };

/** Shape-matched pulsing placeholder. Hidden from screen readers — loading
 *  states should never be read aloud as if they were content. */
export function LoadingSkeleton({ variant = 'row', height, style }: Props) {
  const anim = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.base, { height: height ?? DEFAULT_HEIGHT[variant], opacity: anim }, style]}
    />
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: color.bg.surface2, borderRadius: radius.md, width: '100%' },
});
