import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { focusManager } from '@tanstack/react-query';

/**
 * Wires React Native's AppState to react-query's focusManager.
 *
 * react-query's `refetchOnWindowFocus` (already the framework default —
 * true, gated by each query's staleTime, never a loop) is a no-op on RN
 * without this: there's no browser window-focus event, so `focusManager`
 * never learns the app came back to the foreground. This hook is the only
 * thing needed to activate that existing default behavior on RN.
 *
 * Mount exactly once, at the app root (see app/_layout.tsx) — never per
 * screen, matching the P1.2 spec's explicit "one listener, root level" rule.
 */
export function useReactQueryFocusSync() {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    });
    return () => subscription.remove();
  }, []);
}
