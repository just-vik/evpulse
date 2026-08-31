import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const specs = [
    // ─── Model 3 ──────────────────────────────────────────────────────────────
    // Original (2017-2020)
    { id: 'spec_m3_sr_us_19',       modelCode: 'model3_rwd',         displayName: 'Model 3 Standard Range+',    year: 2019, region: 'US', batteryNominalKwh: 50,   batteryUsableKwh: 49,   rangeWltp: null, rangeEpa: 250,  peakChargingKw: 170, cellChemistry: 'NMC' },
    { id: 'spec_m3_lr_us_19',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD',     year: 2019, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 73.5, rangeWltp: null, rangeEpa: 322,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_lr_eu_19',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD',     year: 2019, region: 'EU', batteryNominalKwh: 75,   batteryUsableKwh: 73.5, rangeWltp: 530,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    // Refresh (2021-2023): LFP SR in EU/CN, NMC LR
    { id: 'spec_m3_rwd_eu_21',      modelCode: 'model3_rwd',         displayName: 'Model 3 RWD (LFP)',          year: 2021, region: 'EU', batteryNominalKwh: 60,   batteryUsableKwh: 57.5, rangeWltp: 438,  rangeEpa: null, peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_m3_rwd_cn_21',      modelCode: 'model3_rwd',         displayName: 'Model 3 RWD (LFP)',          year: 2021, region: 'CN', batteryNominalKwh: 60,   batteryUsableKwh: 57.5, rangeWltp: 438,  rangeEpa: null, peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_m3_lr_us_21',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD',     year: 2021, region: 'US', batteryNominalKwh: 82,   batteryUsableKwh: 75,   rangeWltp: null, rangeEpa: 358,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_lr_eu_21',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD',     year: 2021, region: 'EU', batteryNominalKwh: 82,   batteryUsableKwh: 75,   rangeWltp: 602,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_perf_us_21',     modelCode: 'model3_performance', displayName: 'Model 3 Performance',        year: 2021, region: 'US', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: null, rangeEpa: 315,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_perf_eu_21',     modelCode: 'model3_performance', displayName: 'Model 3 Performance',        year: 2021, region: 'EU', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: 498,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    // Highland (2024+)
    { id: 'spec_m3_rwd_eu_24',      modelCode: 'model3_rwd',         displayName: 'Model 3 RWD (Highland)',     year: 2024, region: 'EU', batteryNominalKwh: 60,   batteryUsableKwh: 57.5, rangeWltp: 513,  rangeEpa: null, peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_m3_rwd_us_24',      modelCode: 'model3_rwd',         displayName: 'Model 3 RWD (Highland)',     year: 2024, region: 'US', batteryNominalKwh: 60,   batteryUsableKwh: 57.5, rangeWltp: null, rangeEpa: 272,  peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_m3_lr_eu_24',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD (Highland)', year: 2024, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: 629, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_lr_us_24',       modelCode: 'model3_lr_awd',      displayName: 'Model 3 Long Range AWD (Highland)', year: 2024, region: 'US', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: null, rangeEpa: 358, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_perf_eu_24',     modelCode: 'model3_performance', displayName: 'Model 3 Performance (Highland)', year: 2024, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 79, rangeWltp: 528, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_m3_perf_us_24',     modelCode: 'model3_performance', displayName: 'Model 3 Performance (Highland)', year: 2024, region: 'US', batteryNominalKwh: 82, batteryUsableKwh: 79, rangeWltp: null, rangeEpa: 315, peakChargingKw: 250, cellChemistry: 'NMC' },

    // ─── Model Y ──────────────────────────────────────────────────────────────
    // Gen 1 (2020-2021): 75 kWh pack
    { id: 'spec_my_lr_us_20',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD',     year: 2020, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 72,   rangeWltp: null, rangeEpa: 326,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_us_20',     modelCode: 'modely_performance', displayName: 'Model Y Performance',        year: 2020, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 72,   rangeWltp: null, rangeEpa: 303,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_sr_eu_21',       modelCode: 'modely_sr',          displayName: 'Model Y Standard Range',     year: 2021, region: 'EU', batteryNominalKwh: 60,   batteryUsableKwh: 57,   rangeWltp: 430,  rangeEpa: null, peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_my_sr_us_21',       modelCode: 'modely_sr',          displayName: 'Model Y Standard Range',     year: 2021, region: 'US', batteryNominalKwh: 60,   batteryUsableKwh: 57,   rangeWltp: null, rangeEpa: 244,  peakChargingKw: 170, cellChemistry: 'LFP' },
    { id: 'spec_my_lr_us_21',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD',     year: 2021, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 72,   rangeWltp: null, rangeEpa: 330,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lr_eu_21',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD',     year: 2021, region: 'EU', batteryNominalKwh: 75,   batteryUsableKwh: 72,   rangeWltp: 507,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    // Gen 2 (2022-2023): 82 kWh pack
    { id: 'spec_my_lr_eu_22',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD',     year: 2022, region: 'EU', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: 533,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lr_us_22',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD',     year: 2022, region: 'US', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: null, rangeEpa: 330,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_eu_22',     modelCode: 'modely_performance', displayName: 'Model Y Performance',        year: 2022, region: 'EU', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: 514,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_us_22',     modelCode: 'modely_performance', displayName: 'Model Y Performance',        year: 2022, region: 'US', batteryNominalKwh: 82,   batteryUsableKwh: 78,   rangeWltp: null, rangeEpa: 303,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lrrwd_eu_22',    modelCode: 'modely_lr_rwd',      displayName: 'Model Y Long Range RWD',     year: 2022, region: 'EU', batteryNominalKwh: 78,   batteryUsableKwh: 75,   rangeWltp: 533,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    // Juniper (2024+): minor usable capacity improvement, aerodynamics refresh
    { id: 'spec_my_lr_eu_24',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD (Juniper)', year: 2024, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: 600, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lr_us_24',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD (Juniper)', year: 2024, region: 'US', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: null, rangeEpa: 320, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_eu_24',     modelCode: 'modely_performance', displayName: 'Model Y Performance (Juniper)',    year: 2024, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: 514, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_us_24',     modelCode: 'modely_performance', displayName: 'Model Y Performance (Juniper)',    year: 2024, region: 'US', batteryNominalKwh: 82, batteryUsableKwh: 78, rangeWltp: null, rangeEpa: 291, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lrrwd_eu_24',    modelCode: 'modely_lr_rwd',      displayName: 'Model Y Long Range RWD (Juniper)', year: 2024, region: 'EU', batteryNominalKwh: 78, batteryUsableKwh: 75, rangeWltp: 533, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lrrwd_eu_25',    modelCode: 'modely_lr_rwd',      displayName: 'Model Y Long Range RWD (Juniper)', year: 2025, region: 'EU', batteryNominalKwh: 78, batteryUsableKwh: 75, rangeWltp: 533, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_lr_eu_25',       modelCode: 'modely_lr_awd',      displayName: 'Model Y Long Range AWD (Juniper)', year: 2025, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 79, rangeWltp: 600, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_my_perf_eu_25',     modelCode: 'modely_performance', displayName: 'Model Y Performance (Juniper)',    year: 2025, region: 'EU', batteryNominalKwh: 82, batteryUsableKwh: 79, rangeWltp: 514, rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },

    // ─── Model S ──────────────────────────────────────────────────────────────
    { id: 'spec_ms_85_us_13',       modelCode: 'models_85',          displayName: 'Model S 85',                 year: 2013, region: 'US', batteryNominalKwh: 85,   batteryUsableKwh: 80.8, rangeWltp: null, rangeEpa: 265,  peakChargingKw: 120, cellChemistry: 'NMC' },
    { id: 'spec_ms_p85d_us_15',     modelCode: 'models_p85d',        displayName: 'Model S P85D',               year: 2015, region: 'US', batteryNominalKwh: 85,   batteryUsableKwh: 80.8, rangeWltp: null, rangeEpa: 253,  peakChargingKw: 120, cellChemistry: 'NMC' },
    { id: 'spec_ms_90d_us_15',      modelCode: 'models_90d',         displayName: 'Model S 90D',                year: 2015, region: 'US', batteryNominalKwh: 90,   batteryUsableKwh: 85.5, rangeWltp: null, rangeEpa: 294,  peakChargingKw: 120, cellChemistry: 'NMC' },
    { id: 'spec_ms_75d_us_16',      modelCode: 'models_75d',         displayName: 'Model S 75D',                year: 2016, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 72.5, rangeWltp: null, rangeEpa: 249,  peakChargingKw: 100, cellChemistry: 'NMC' },
    { id: 'spec_ms_100d_us_17',     modelCode: 'models_lr',          displayName: 'Model S 100D',               year: 2017, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 335,  peakChargingKw: 150, cellChemistry: 'NMC' },
    { id: 'spec_ms_lr_us_21',       modelCode: 'models_lr',          displayName: 'Model S Long Range',         year: 2021, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 405,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_ms_plaid_us_21',    modelCode: 'models_plaid',       displayName: 'Model S Plaid',              year: 2021, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 396,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_ms_lr_eu_23',       modelCode: 'models_lr',          displayName: 'Model S Long Range',         year: 2023, region: 'EU', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: 652,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_ms_plaid_eu_23',    modelCode: 'models_plaid',       displayName: 'Model S Plaid',              year: 2023, region: 'EU', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: 637,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },

    // ─── Model X ──────────────────────────────────────────────────────────────
    { id: 'spec_mx_75d_us_16',      modelCode: 'modelx_75d',         displayName: 'Model X 75D',                year: 2016, region: 'US', batteryNominalKwh: 75,   batteryUsableKwh: 72.5, rangeWltp: null, rangeEpa: 237,  peakChargingKw: 100, cellChemistry: 'NMC' },
    { id: 'spec_mx_90d_us_16',      modelCode: 'modelx_90d',         displayName: 'Model X 90D',                year: 2016, region: 'US', batteryNominalKwh: 90,   batteryUsableKwh: 85.5, rangeWltp: null, rangeEpa: 257,  peakChargingKw: 120, cellChemistry: 'NMC' },
    { id: 'spec_mx_100d_us_17',     modelCode: 'modelx_lr',          displayName: 'Model X 100D',               year: 2017, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 295,  peakChargingKw: 150, cellChemistry: 'NMC' },
    { id: 'spec_mx_lr_us_21',       modelCode: 'modelx_lr',          displayName: 'Model X Long Range',         year: 2021, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 348,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_mx_plaid_us_22',    modelCode: 'modelx_plaid',       displayName: 'Model X Plaid',              year: 2022, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 333,  peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_mx_lr_eu_23',       modelCode: 'modelx_lr',          displayName: 'Model X Long Range',         year: 2023, region: 'EU', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: 580,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },
    { id: 'spec_mx_plaid_eu_23',    modelCode: 'modelx_plaid',       displayName: 'Model X Plaid',              year: 2023, region: 'EU', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: 543,  rangeEpa: null, peakChargingKw: 250, cellChemistry: 'NMC' },

    // ─── Cybertruck ───────────────────────────────────────────────────────────
    { id: 'spec_ct_rwd_us_24',      modelCode: 'cybertruck_rwd',     displayName: 'Cybertruck RWD',             year: 2024, region: 'US', batteryNominalKwh: 100,  batteryUsableKwh: 95,   rangeWltp: null, rangeEpa: 340,  peakChargingKw: 350, cellChemistry: 'NMC' },
    { id: 'spec_ct_awd_us_24',      modelCode: 'cybertruck_awd',     displayName: 'Cybertruck AWD',             year: 2024, region: 'US', batteryNominalKwh: 123,  batteryUsableKwh: 118,  rangeWltp: null, rangeEpa: 340,  peakChargingKw: 350, cellChemistry: 'NMC' },
    { id: 'spec_ct_beast_us_24',    modelCode: 'cybertruck_beast',   displayName: 'Cybertruck Cyberbeast',      year: 2024, region: 'US', batteryNominalKwh: 123,  batteryUsableKwh: 118,  rangeWltp: null, rangeEpa: 320,  peakChargingKw: 350, cellChemistry: 'NMC' },
  ];

  let upserted = 0;
  for (const spec of specs) {
    await prisma.vehicleSpec.upsert({
      where: { modelCode_year_region: { modelCode: spec.modelCode, year: spec.year, region: spec.region } },
      update: {
        batteryNominalKwh: spec.batteryNominalKwh,
        batteryUsableKwh:  spec.batteryUsableKwh,
        cellChemistry:     spec.cellChemistry,
        ...(spec.rangeWltp      != null ? { rangeWltp:      spec.rangeWltp      } : {}),
        ...(spec.rangeEpa       != null ? { rangeEpa:       spec.rangeEpa       } : {}),
        ...(spec.peakChargingKw != null ? { peakChargingKw: spec.peakChargingKw } : {}),
      },
      create: {
        id:                spec.id,
        modelCode:         spec.modelCode,
        displayName:       spec.displayName,
        year:              spec.year,
        region:            spec.region,
        batteryNominalKwh: spec.batteryNominalKwh,
        batteryUsableKwh:  spec.batteryUsableKwh,
        rangeWltp:         spec.rangeWltp ?? undefined,
        rangeEpa:          spec.rangeEpa ?? undefined,
        peakChargingKw:    spec.peakChargingKw ?? undefined,
        cellChemistry:     spec.cellChemistry,
      },
    });
    upserted++;
  }

  console.log(`Seeded/updated ${upserted} vehicle specs`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
