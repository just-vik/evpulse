'use client';

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { useTranslation } from 'react-i18next';
import { reconciliationDelayMs, classifyCommandError, shouldReuseIdempotencyKey } from './vehicleCommandPolicy';

export function useVehicleCommands(vehicleId: string) {
  const { accessToken } = useAuthStore();
  const addToast = useUIStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  // P1.6b: one pending Idempotency-Key per command name, kept only while
  // that command's outcome is still unknown (see shouldReuseIdempotencyKey).
  // The server dedups on this key so a resend after a lost/timed-out
  // response replays the cached result instead of hitting Tesla again.
  const pendingKeysRef = useRef<Map<string, string>>(new Map());

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });

  const mutation = useMutation({
    // P1.6a: commands are side-effecting Tesla actions, not idempotent form
    // submissions — never auto-retry. The app-wide QueryClient default
    // (mutations.retry: 1) is intentionally overridden here, not changed
    // globally.
    retry: 0,

    mutationFn: ({ command, params, idempotencyKey }: { command: string; params?: Record<string, unknown>; idempotencyKey: string }) =>
      apiClient.sendVehicleCommand(vehicleId, command, params ?? {}, accessToken!, idempotencyKey),

    // No onMutate / optimistic cache patch: vehicle state must only ever
    // change from a confirmed REST/WS read. A command being *accepted* by
    // this endpoint is not the same as Tesla having executed it.

    onError: (err: any, { command }) => {
      const { messageKey, refresh, category } = classifyCommandError(err);
      if (!shouldReuseIdempotencyKey(category)) pendingKeysRef.current.delete(command);
      addToast('error', t(messageKey));
      if (refresh === 'delayed') setTimeout(invalidateStatus, reconciliationDelayMs(command));
      else if (refresh === 'immediate') invalidateStatus();
      // refresh === 'none': nothing reached the vehicle — no read needed.
    },

    onSuccess: (_, { command }) => {
      pendingKeysRef.current.delete(command);
      // Truthful: the request was accepted, not that the vehicle state has
      // actually changed yet — that only happens once the delayed refresh
      // below (or a live WS event) confirms it.
      addToast('success', t('vehicleDetail.commands.success'));
      setTimeout(invalidateStatus, reconciliationDelayMs(command));
    },
  });

  return {
    send: (command: string, params?: Record<string, unknown>) => {
      const idempotencyKey = pendingKeysRef.current.get(command) ?? crypto.randomUUID();
      pendingKeysRef.current.set(command, idempotencyKey);
      mutation.mutate({ command, params, idempotencyKey });
    },
    isBusy: mutation.isPending,
    busyCommand: mutation.isPending ? (mutation.variables?.command ?? null) : null,
  };
}
