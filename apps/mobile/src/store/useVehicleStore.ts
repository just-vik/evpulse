import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const KEY = 'selected_vehicle_id';

interface VehicleState {
  selectedVehicleId: string | null;
  setSelectedVehicleId: (id: string | null) => Promise<void>;
  hydrateVehicle: () => Promise<void>;
}

export const useVehicleStore = create<VehicleState>((set, get) => ({
  selectedVehicleId: null,

  setSelectedVehicleId: async (id) => {
    if (id) await SecureStore.setItemAsync(KEY, id);
    else await SecureStore.deleteItemAsync(KEY);
    set({ selectedVehicleId: id });
  },

  hydrateVehicle: async () => {
    const id = await SecureStore.getItemAsync(KEY);
    set({ selectedVehicleId: id });
  },
}));
