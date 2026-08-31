'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export default function BillingSuccessPage() {
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    // Invalidate subscription cache so next page load reflects the new plan
    qc.invalidateQueries({ queryKey: ['billing', 'me'] });
    const t = setTimeout(() => router.replace('/settings'), 3500);
    return () => clearTimeout(t);
  }, [qc, router]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center px-6">
      <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
        <CheckCircle size={32} className="text-green-500" />
      </div>
      <h1 className="text-xl font-semibold text-foreground">Подписка активирована!</h1>
      <p className="text-sm text-muted-foreground max-w-xs">
        Вся накопленная история уже доступна. Переходим в настройки…
      </p>
    </div>
  );
}
