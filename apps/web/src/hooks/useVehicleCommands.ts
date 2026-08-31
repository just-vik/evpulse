'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, type VehicleStatusResponse } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { useTranslation } from 'react-i18next';

// Which status fields each command can optimistically update
function optimisticPatch(command: string): Partial<VehicleStatusResponse> | null {
  switch (command) {
    case 'lock':           return { locked: true };
    case 'unlock':         return { locked: false };
    case 'start-charging': return { chargingState: 'Charging' };
    case 'stop-charging':  return { chargingState: 'Stopped' };
    case 'wake':           return { vehicleState: 'waking' };
    default:               return null;
  }
}

export function useVehicleCommands(vehicleId: string) {
  const { accessToken } = useAuthStore();
  const addToast = useUIStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: ({ command, params }: { command: string; params?: Record<string, unknown> }) =>
      apiClient.sendVehicleCommand(vehicleId, command, params ?? {}, accessToken!),

    onMutate: async ({ command }) => {
      const key = ['vehicle-status', vehicleId];
      // Pause background refetches so they don't overwrite our optimistic state
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<VehicleStatusResponse>(key);

      const patch = optimisticPatch(command);
      if (patch) {
        queryClient.setQueryData<VehicleStatusResponse>(key, (old) =>
          old ? { ...old, ...patch } : old,
        );
      }
      return { previous, command };
    },

    onError: (err: any, { command }, context) => {
      // Revert optimistic update
      if (context?.previous) {
        queryClient.setQueryData(['vehicle-status', vehicleId], context.previous);
      }
      const status = Number(err?.status ?? 0);
      const msg = String(err?.message ?? '').trim();
      if (status === 429) {
        addToast('error', `${t('common.error')} 429: ${command}`);
      } else {
        addToast('error', msg || t('vehicleDetail.commands.failed'));
      }
    },

    onSuccess: (_, { command }) => {
      addToast('success', t('vehicleDetail.commands.success'));
      // Delayed refresh to let Tesla API propagate state change
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });
      }, command === 'wake' ? 8_000 : 3_000);
    },

    onSettled: () => {
      // Always revalidate after command completes, regardless of outcome
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['vehicle-status', vehicleId] });
      }, 500);
    },
  });

  return {
    send: (command: string, params?: Record<string, unknown>) =>
      mutation.mutate({ command, params }),
    isBusy: mutation.isPending,
    busyCommand: mutation.isPending ? (mutation.variables?.command ?? null) : null,
  };
}
