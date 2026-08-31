import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { api } from '@/services/api';

export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  user: UserProfile | null;
  hydrated: boolean;
  setSession: (tokens: {
    accessToken: string;
    refreshToken: string;
    user: UserProfile;
  }) => Promise<void>;
  clearSession: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  refreshToken: null,
  userId: null,
  user: null,
  hydrated: false,

  setSession: async ({ accessToken, refreshToken, user }) => {
    await SecureStore.setItemAsync('access_token', accessToken);
    await SecureStore.setItemAsync('refresh_token', refreshToken);
    await SecureStore.setItemAsync('user_id', user.id);
    set({
      accessToken,
      refreshToken,
      userId: user.id,
      user,
    });
  },

  clearSession: async () => {
    await SecureStore.deleteItemAsync('access_token');
    await SecureStore.deleteItemAsync('refresh_token');
    await SecureStore.deleteItemAsync('user_id');
    set({
      accessToken: null,
      refreshToken: null,
      userId: null,
      user: null,
    });
  },

  hydrate: async () => {
    if (get().hydrated) return;
    const [accessToken, refreshToken, userId] = await Promise.all([
      SecureStore.getItemAsync('access_token'),
      SecureStore.getItemAsync('refresh_token'),
      SecureStore.getItemAsync('user_id'),
    ]);
    set({ accessToken, refreshToken, userId, hydrated: true });
    if (!accessToken) return;
    try {
      const { data } = await api.get<UserProfile>('/users/profile');
      set({ user: data });
    } catch {
      await get().clearSession();
    }
  },
}));
