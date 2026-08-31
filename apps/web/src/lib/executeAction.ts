'use client';

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { InsightAction } from '@/lib/insights';
import { apiClient } from '@/lib/api';

interface ExecuteOptions {
  vehicleId: string;
  token: string;
  router: AppRouterInstance;
  onSuccess?: (message: string) => void;
  onError?: (message: string) => void;
}

export async function executeAction(
  action: InsightAction,
  opts: ExecuteOptions,
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      opts.router.push(action.href);
      break;

    case 'command':
      try {
        await apiClient.sendCommand(opts.vehicleId, action.command, opts.token);
        opts.onSuccess?.(`Command "${action.label}" sent`);
      } catch {
        opts.onError?.(`Failed to send "${action.label}"`);
      }
      break;

    case 'ai':
      // Opens AI chat with the pre-filled prompt — to be wired to AI panel
      opts.router.push(`/ai?q=${encodeURIComponent(action.prompt)}`);
      break;
  }
}
