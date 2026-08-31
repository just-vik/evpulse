'use client';

import { useRouter } from 'next/navigation';
import { XCircle } from 'lucide-react';

export default function BillingCancelPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center px-6">
      <div className="w-16 h-16 rounded-full bg-[hsl(var(--secondary)/0.6)] flex items-center justify-center">
        <XCircle size={32} className="text-muted-foreground" />
      </div>
      <h1 className="text-xl font-semibold text-foreground">Оплата отменена</h1>
      <p className="text-sm text-muted-foreground max-w-xs">
        Ничего не было списано. Вы можете попробовать снова когда будете готовы.
      </p>
      <button
        onClick={() => router.replace('/settings')}
        className="mt-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-brand-500 text-white hover:bg-brand-600 transition"
      >
        Вернуться в настройки
      </button>
    </div>
  );
}
