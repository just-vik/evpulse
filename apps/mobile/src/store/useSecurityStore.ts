import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const KEY = 'biometric_lock_enabled';

interface SecurityState {
  biometricLockEnabled: boolean;
  setBiometricLockEnabled: (v: boolean) => Promise<void>;
  hydrateSecurity: () => Promise<void>;
}

export const useSecurityStore = create<SecurityState>((set) => ({
  biometricLockEnabled: false,

  setBiometricLockEnabled: async (v) => {
    if (v) await SecureStore.setItemAsync(KEY, '1');
    else await SecureStore.deleteItemAsync(KEY);
    set({ biometricLockEnabled: v });
  },

  hydrateSecurity: async () => {
    const raw = await SecureStore.getItemAsync(KEY);
    set({ biometricLockEnabled: raw === '1' });
  },
}));
