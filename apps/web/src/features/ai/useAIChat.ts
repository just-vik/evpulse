'use client';

import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layout.store';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: Date;
}

export function useAIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const { accessToken } = useAuthStore();
  const selectedVehicleId = useLayoutStore((s) => s.selectedVehicleId);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || !accessToken) return;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, ts: new Date() };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    try {
      const res = await apiClient.askAI(text, selectedVehicleId, accessToken);
      const aiMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: res.answer, ts: new Date() };
      setMessages((m) => [...m, aiMsg]);
    } catch {
      const errMsg: ChatMessage = {
        id: crypto.randomUUID(), role: 'assistant',
        content: 'Sorry, I could not process that request.',
        ts: new Date(),
      };
      setMessages((m) => [...m, errMsg]);
    } finally {
      setLoading(false);
    }
  }, [accessToken, selectedVehicleId]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, send, loading, clear };
}
