// Central re-export barrel for hooks.
// Note: components import hooks directly (e.g. import { useVehicles } from '@/hooks/useVehicles')
// rather than from this barrel, but the barrel is kept for convenience.

export { useAuth } from './useAuth';
export { useVehicles, useVehicle } from './useVehicles';
export { useWebSocket } from './useWebSocket';
export * from './useEfficiencyPrediction';
export * from './useBatteryHealth';
export * from './useCostForecast';
export { useOfflineStatus } from './useOfflineStatus';
export { useCurrency } from './useCurrency';
export { useExchangeRates, convertCurrency } from './useExchangeRates';
export * from './usePeriodComparison';
export { useTelemetryFreshness } from './useTelemetryFreshness';
export { useVehicleCommands } from './useVehicleCommands';
