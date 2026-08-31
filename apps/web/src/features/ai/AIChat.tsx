'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Sparkles, X, Send, Loader2, Bot, User, Trash2 } from 'lucide-react';
import { useAIChat } from './useAIChat';
import { create } from 'zustand';

/* ── panel visibility store ──────────────────────────────────────────────── */
interface AIChatStore {
  open: boolean;
  initialPrompt: string | null;
  openChat: (prompt?: string) => void;
  closeChat: () => void;
}

export const useAIChatStore = create<AIChatStore>((set) => ({
  open: false,
  initialPrompt: null,
  openChat: (prompt) => set({ open: true, initialPrompt: prompt ?? null }),
  closeChat: () => set({ open: false, initialPrompt: null }),
}));

/* ── component ───────────────────────────────────────────────────────────── */
export function AIChat() {
  const { open, initialPrompt, closeChat } = useAIChatStore();
  const { messages, send, loading, clear } = useAIChat();
  const { t } = useTranslation();
  const [input, setInput] = React.useState('');
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Auto-send initial prompt when opened with one
  React.useEffect(() => {
    if (open && initialPrompt) {
      send(initialPrompt);
      useAIChatStore.setState({ initialPrompt: null });
    }
  }, [open, initialPrompt, send]);

  // Scroll to bottom on new messages
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  function handleSend() {
    if (!input.trim() || loading) return;
    send(input.trim());
    setInput('');
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.97 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-x-2 lg:inset-x-auto lg:right-4 lg:w-[360px] h-[min(500px,calc(100dvh-140px))] flex flex-col z-40 rounded-2xl border border-slate-700/80 bg-slate-900/95 backdrop-blur-xl shadow-2xl"
          style={{ bottom: 'calc(var(--ai-panel-offset) + env(safe-area-inset-bottom))' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-brand-500/20 flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-brand-500" />
              </div>
              <span className="text-sm font-medium text-white">{t('ai.copilit')}</span>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={clear}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={closeChat}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
                <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-slate-400" />
                </div>
                <p className="text-sm text-slate-400">{t('ai.askAnything')}</p>
                <div className="flex flex-col gap-1.5 w-full">
                  {[t('ai.suggestedQuestions.batteryLife'), t('ai.suggestedQuestions.efficiency'), t('ai.suggestedQuestions.cost')].map((q) => (
                    <button
                      key={q}
                      onClick={() => { send(q); }}
                      className="text-xs text-left px-3 py-2 rounded-lg border border-slate-700/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-3 h-3 text-brand-500" />
                    </div>
                  )}
                  <div className={`
                    max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed
                    ${msg.role === 'user'
                      ? 'bg-brand-500/20 text-white rounded-br-sm'
                      : 'bg-slate-800/80 text-slate-200 rounded-bl-sm'
                    }
                  `}>
                    {msg.content}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="w-3 h-3 text-slate-300" />
                    </div>
                  )}
                </div>
              ))
            )}

            {loading && (
              <div className="flex gap-2 justify-start">
                <div className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3 h-3 text-brand-500" />
                </div>
                <div className="bg-slate-800/80 rounded-xl px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3">
            <div className="flex items-center gap-2 bg-slate-800/80 rounded-xl border border-slate-700/60 px-3 py-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={t('ai.askAnything')}
                className="flex-1 bg-transparent outline-none text-sm text-white placeholder-slate-500"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="w-7 h-7 rounded-lg bg-brand-500/20 hover:bg-brand-500/40 text-brand-500 flex items-center justify-center disabled:opacity-40 transition-colors flex-shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
