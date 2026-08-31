import { useCallback, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { api } from '@/services/api';

WebBrowser.maybeCompleteAuthSession();

export function useTeslaOAuth() {
  const [busy, setBusy] = useState(false);

  const connectTesla = useCallback(async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ url: string }>('/auth/tesla/link');
      if (!data?.url) return { ok: false as const };
      await WebBrowser.openBrowserAsync(data.url);
      return { ok: true as const };
    } finally {
      setBusy(false);
    }
  }, []);

  const pollTeslaStatus = useCallback(async () => {
    const { data } = await api.get<{ connected: boolean }>('/auth/tesla/status');
    return data.connected;
  }, []);

  return { connectTesla, pollTeslaStatus, busy };
}
