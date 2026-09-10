/**
 * TariffResolverService contract — see docs/calculations/tariff-resolver.md
 * for the full design rationale. These types are the finalized contract
 * from that document (§2), not a draft.
 */

export type TariffPurpose =
  | 'actual_cost'          // pricing a real charging session or trip, now
  | 'historical_summary'   // aggregating already-persisted costs (e.g. getCostSummary)
  | 'forecast';            // predicting future cost

export type TariffSource =
  | 'supercharger_catalog'
  | 'vehicle_settings.home'
  | 'vehicle_settings.third_party'
  | 'vehicle_settings.supercharger'
  | 'historical_sessions'
  | 'default';

export interface TariffContext {
  purpose: TariffPurpose;
  vehicleId: string;
  chargerType?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
  timestamp?: Date;
}

export interface TariffResolution {
  rate: number;
  currency: string;
  source: TariffSource;
}
