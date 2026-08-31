'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader, Zap, Truck, Check } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

type Plan = 'PRO' | 'FLEET';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPlan?: Plan;
}

const PLANS: { id: Plan; icon: React.ReactNode; title: string; price: string; features: string[] }[] = [
  {
    id: 'PRO',
    icon: <Zap size={18} />,
    title: 'PRO',
    price: '€4.99/mo',
    features: ['1 год истории поездок', 'AI-инсайты', 'До 2 автомобилей', 'Аналитика батареи'],
  },
  {
    id: 'FLEET',
    icon: <Truck size={18} />,
    title: 'FLEET',
    price: '€19.99/mo',
    features: ['2 года истории', 'Флит-дашборд', 'До 50 авто', 'Webhooks & экспорт'],
  },
];

export function UpgradeModal({ open, onOpenChange, defaultPlan = 'PRO' }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [selected, setSelected] = useState<Plan>(defaultPlan);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  if (!open) return null;

  async function handleUpgrade() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await apiClient.createCheckoutSession(selected, accessToken ?? '');
      window.location.href = url;
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка при создании сессии');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-[hsl(var(--card))] border border-[hsl(var(--border)/0.6)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Улучшить план</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Данные уже собираются — они откроются сразу после апгрейда.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {PLANS.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p.id)}
              className={`rounded-xl p-4 text-left border transition-all ${
                selected === p.id
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-[hsl(var(--border)/0.6)] bg-[hsl(var(--secondary)/0.4)] hover:border-brand-500/50'
              }`}
            >
              <div className="flex items-center gap-2 text-foreground font-semibold mb-1">
                <span className={selected === p.id ? 'text-brand-500' : 'text-muted-foreground'}>{p.icon}</span>
                {p.title}
              </div>
              <div className="text-xs font-medium text-brand-500 mb-2">{p.price}</div>
              <ul className="space-y-1">
                {p.features.map((f) => (
                  <li key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Check size={11} className="text-brand-500 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <p className="text-[11px] text-muted-foreground text-center">
          By subscribing you agree to our{' '}
          <Link href="/privacy" target="_blank" className="underline underline-offset-2 hover:text-foreground transition-colors">
            Privacy Policy
          </Link>
          . Payments are processed securely by Stripe.
        </p>

        <div className="flex gap-3">
          <button
            onClick={() => onOpenChange(false)}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm text-muted-foreground border border-[hsl(var(--border)/0.6)] hover:bg-[hsl(var(--secondary)/0.5)] transition"
          >
            Отмена
          </button>
          <button
            onClick={handleUpgrade}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-60 transition flex items-center justify-center gap-2"
          >
            {loading ? <Loader size={14} className="animate-spin" /> : <Zap size={14} />}
            Перейти к оплате
          </button>
        </div>
      </div>
    </div>
  );
}
