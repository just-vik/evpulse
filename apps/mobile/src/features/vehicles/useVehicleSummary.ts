import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useVehicleStore } from '@/store/useVehicleStore';

export interface VehicleRow {
  id: string;
  model: string;
  displayName?: string | null;
}

/** Backend's real `DataQuality` union (apps/api/src/analytics/vehicle-analytics.service.ts). */
export type DataQuality = 'REALTIME' | 'DELAYED' | 'STALE' | 'OFFLINE';

/**
 * GET /vehicles/:id/status response — verified against
 * apps/api/src/analytics/vehicle-analytics.service.ts `getVehicleStatus`.
 * Only the fields the mobile UI actually consumes are typed here; the
 * endpoint also returns speed/batteryTemp/voltage/insideTemp/odometer/
 * drivingState/locked/isOnline, intentionally left untyped/unused for P0.
 */
export interface VehicleStatus {
  soc: number | null;
  batteryRangeKm: number | null;
  outsideTemp: number | null;
  chargingState: string | null;
  vehicleState: string;
  lastUpdate?: string | null;
  power: number | null;
  dataQuality: DataQuality;
  dataFreshnessSec: number | null;
}

export function useVehicleSummary() {
  const selectedVehicleId = useVehicleStore((s) => s.selectedVehicleId);
  const setSelectedVehicleId = useVehicleStore((s) => s.setSelectedVehicleId);

  const vehiclesQuery = useQuery({
    queryKey: ['vehicles'],
    queryFn: async () => {
      const { data } = await api.get<VehicleRow[]>('/vehicles');
      return data;
    },
  });

  const effectiveId =
    selectedVehicleId ??
    (vehiclesQuery.data?.length ? vehiclesQuery.data[0].id : null);

  useEffect(() => {
    if (vehiclesQuery.data?.length && !selectedVehicleId) {
      void setSelectedVehicleId(vehiclesQuery.data[0].id);
    }
  }, [vehiclesQuery.data, selectedVehicleId, setSelectedVehicleId]);

  const statusQuery = useQuery({
    queryKey: ['vehicle-status', effectiveId],
    queryFn: async () => {
      const { data } = await api.get<VehicleStatus>(
        `/vehicles/${effectiveId}/status`,
      );
      return data;
    },
    enabled: !!effectiveId,
  });

  return {
    vehiclesQuery,
    statusQuery,
    vehicleId: effectiveId,
    setSelectedVehicleId,
  };
}
