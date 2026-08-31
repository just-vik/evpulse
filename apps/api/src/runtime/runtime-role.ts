export type AppRole = 'api' | 'worker' | 'all';

export function getAppRole(): AppRole {
  const raw = (process.env.APP_ROLE ?? 'all').toLowerCase();
  if (raw === 'api' || raw === 'worker' || raw === 'all') return raw;
  return 'all';
}

export function isApiRole(): boolean {
  const role = getAppRole();
  return role === 'api' || role === 'all';
}

export function isWorkerRole(): boolean {
  const role = getAppRole();
  return role === 'worker' || role === 'all';
}
