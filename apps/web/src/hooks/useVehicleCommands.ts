'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { useTranslation } from 'react-i18next';
import { reconciliationDelayMs, classifyCommandError } from './vehicleCommandPolicy';

export function useVehicleCommands(vehicleId: string) {
  const { accessToken } = useAuthStore();
  const addToast = useUIStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });

  const mutation = useMutation({
    // P1.6a: commands are side-effecting Tesla actions, not idempotent form
    // submissions — never auto-retry. The app-wide QueryClient default
    // (mutations.retry: 1) is intentionally overridden here, not changed
    // globally. Durable server-side idempotency (P1.6b) is still required
    // to protect against a user re-sending after a lost/timed-out response;
    // this only removes the *automatic*, invisible client-side duplicate.
    retry: 0,

    mutationFn: ({ command, params }: { command: string; params?: Record<string, unknown> }) =>
      apiClient.sendVehicleCommand(vehicleId, command, params ?? {}, accessToken!),

    // No onMutate / optimistic cache patch: vehicle state must only ever
    // change from a confirmed REST/WS read. A command being *accepted* by
    // this endpoint is not the same as Tesla having executed it.

    onError: (err: any, { command }) => {
      const { messageKey, refresh } = classifyCommandError(err);
      addToast('error', t(messageKey));
      if (refresh === 'delayed') setTimeout(invalidateStatus, reconciliationDelayMs(command));
      else if (refresh === 'immediate') invalidateStatus();
      // refresh === 'none': nothing reached the vehicle — no read needed.
    },

    onSuccess: (_, { command }) => {
      // Truthful: the request was accepted, not that the vehicle state has
      // actually changed yet — that only happens once the delayed refresh
      // below (or a live WS event) confirms it.
      addToast('success', t('vehicleDetail.commands.success'));
      setTimeout(invalidateStatus, reconciliationDelayMs(command));
    },
  });

  return {
    send: (command: string, params?: Record<string, unknown>) =>
      mutation.mutate({ command, params }),
    isBusy: mutation.isPending,
    busyCommand: mutation.isPending ? (mutation.variables?.command ?? null) : null,
  };
}
