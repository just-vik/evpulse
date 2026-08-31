import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface DecodedVin {
  model: string | null;
  modelCode: string | null;
  year: number | null;
  drivetrainCode: string | null;
}

interface DetectedSpecs {
  modelCode: string;
  displayName: string;
  region: string;
  year: number | null;
  batteryNominalKwh: number;
  batteryUsableKwh: number;
  rangeWltp: number | null;
  peakChargingKw: number | null;
  cellChemistry: 'NMC' | 'LFP';
  generation: string | null;
  manufactureDate: string | null;
  trim?: string;
  driveType?: string;
}

@Injectable()
export class VehicleSpecsService {
  private readonly logger = new Logger(VehicleSpecsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decode basic info from Tesla VIN (17-char standard).
   * Position 3 = model, 4 = drive unit / variant, 9 = model year (MY char).
   */
  decodeTeslaVin(vin: string): DecodedVin {
    if (!vin || vin.length < 10) {
      return { model: null, modelCode: null, year: null, drivetrainCode: null };
    }

    const modelChar     = vin[3];
    const driveChar     = vin[4];
    const yearChar      = vin[9];

    const modelMap: Record<string, string> = {
      S: 'Model S',
      '3': 'Model 3',
      X: 'Model X',
      Y: 'Model Y',
      C: 'Cybertruck',
    };

    // Full MY character map: A=2010 … T=2026 (I/O/Q/Z/U skipped per SAE J1703)
    const yearMap: Record<string, number> = {
      A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015,
      G: 2016, H: 2017, J: 2018, K: 2019, L: 2020, M: 2021,
      N: 2022, P: 2023, R: 2024, S: 2025, T: 2026,
    };

    const model     = modelMap[modelChar] ?? null;
    const year      = yearMap[yearChar]   ?? null;
    const modelCode = model ? model.toLowerCase().replace(/\s+/g, '') : null;

    return { model, modelCode, year, drivetrainCode: driveChar };
  }

  /**
   * Best-effort detection of nominal/usable capacity, trim, peak charging power
   * and WLTP range using VIN and Tesla vehicle payload.
   *
   * Data sources (best → worst priority):
   *   1. car_type from vehicle_config (Fleet Telemetry CarType / REST car_type)
   *      — modely2 = Juniper (2025+), model3p = Highland (2024+), models3/modelx2 = Plaid-era
   *   2. vehicle_config.trim_badging / motor_type (from /vehicle_data)
   *   3. VIN position 4 (drive unit) + position 3 (model) + position 10 (year)
   *   4. Conservative defaults
   *
   * Capacity references (EU/Berlin specs, Oct 2025 lineup):
   *   Model Y Juniper (carType=modely2, EU)
   *     Standard RWD:   64.5/60.5 kWh LFP, 534 km WLTP, 175 kW DC
   *     Premium RWD:    79/75 kWh NMC,      609 km WLTP, 250 kW DC
   *     Premium AWD:    83/79 kWh NMC,      600 km WLTP, 250 kW DC
   *     Performance:    83/79 kWh NMC,      580 km WLTP, 250 kW DC
   *   Model Y Legacy (carType=modely)
   *     LR AWD (2022+): 82/78 kWh NMC,     533 km WLTP, 250 kW DC
   *     LR RWD (2022+): 78/75 kWh NMC,     533 km WLTP, 250 kW DC
   *     SR (LFP):       60/57 kWh LFP,     466 km WLTP, 170 kW DC
   *   Model 3 Highland (carType=model3p, EU)
   *     LR AWD:         82/78 kWh NMC,     629 km WLTP, 250 kW DC
   *     Performance:    82/79 kWh NMC,     528 km WLTP, 250 kW DC
   *     RWD (LFP):      60/57.5 kWh LFP,  513 km WLTP, 170 kW DC
   *   Model S
   *     Plaid / LR:    100/95 kWh NMC,     637/652 km WLTP, 250 kW DC
   *   Model X
   *     Plaid / LR:    100/95 kWh NMC,     543/543 km WLTP, 250 kW DC
   *   Cybertruck
   *     AWD/Beast:     123/118 kWh NMC,    547 km EPA, 350 kW DC
   *     RWD:           100/95 kWh NMC,     547 km EPA, 350 kW DC
   */
  detectFromTeslaPayload(vin: string, apiVehicle: any): DetectedSpecs {
    const decoded = this.decodeTeslaVin(vin);

    // Prefer vehicle_config from /vehicle_data when available
    const cfg          = apiVehicle?.vehicle_config ?? null;
    const carType      = (cfg?.car_type ?? '').toLowerCase() as string;
    const trimBadging  = (cfg?.trim_badging ?? '') as string;
    const motorType    = (cfg?.motor_type ?? '') as string;
    const optionCodes  = (apiVehicle?.option_codes ?? '') as string;

    // Fleet Telemetry carType values for refreshed models:
    //   modely2 = Model Y Juniper (2025+), model3p = Model 3 Highland (2024+)
    //   models3 = Model S Plaid-era (2021+), modelx2 = Model X Plaid-era (2021+)
    const isJuniperCarType  = carType === 'modely2';
    const isHighlandCarType = carType === 'model3p';

    // manufactureDate: present in some /vehicle_data payloads; used for Juniper date-check
    const manufactureDate: string | null =
      apiVehicle?.manufacture_date ?? cfg?.manufacture_date ?? null;
    const mfgYear  = manufactureDate ? new Date(manufactureDate).getFullYear() : null;
    const mfgMonth = manufactureDate ? new Date(manufactureDate).getMonth() + 1 : null;

    const region = this.inferRegionFromVin(vin);
    const year   = decoded.year ?? apiVehicle?.year ?? null;

    // Working defaults – will be overridden below
    let batteryNominalKwh : number           = 75;
    let batteryUsableKwh  : number           = 72;
    let rangeWltp         : number | null    = null;
    let peakChargingKw    : number | null    = null;
    let cellChemistry     : 'NMC' | 'LFP'   = 'NMC';
    // Generation is intentionally null unless we have unambiguous evidence.
    // Juniper and Highland have the same VIN year chars as their predecessors,
    // so we can only be confident for model3 2024+ (all Highland) and modely
    // AWD/Perf from 2025 (Juniper production cutover confirmed).
    let generation        : string | null    = null;
    let displayName       : string           = decoded.model ?? apiVehicle?.display_name ?? 'Tesla';
    let modelCode         : string           = decoded.modelCode ?? (carType || 'tesla');
    let trim              : string | undefined;
    let driveType         : string | undefined;

    const setPack = (
      nominal: number, usable: number,
      wltp: number | null, peak: number | null,
      chemistry: 'NMC' | 'LFP' = 'NMC',
    ) => {
      batteryNominalKwh = nominal;
      batteryUsableKwh  = usable;
      rangeWltp         = wltp;
      peakChargingKw    = peak;
      cellChemistry     = chemistry;
    };

    const badge = trimBadging?.toLowerCase() ?? '';
    const drive = decoded.drivetrainCode ?? '';
    const yr    = year ?? 0;

    // ── Model Y (all generations) ─────────────────────────────────────────────
    // Generation detection priority:
    //  1. carType 'modely2' from Fleet Telemetry → confirmed Juniper
    //  2. VIN year ≥ 2026 (T) → all Berlin MY are Juniper from 2026
    //  3. Trim-based: LR AWD or Performance + yr ≥ 2025 → Juniper
    //     (Legacy LR AWD/Perf production ended before 2025 S-year VINs started)
    //  4. manufactureDate ≥ 2025-01 available → Juniper (Berlin started Jan 14, 2025)
    //  5. LR RWD + yr 2025 + no manufactureDate → null (truly ambiguous)
    if (decoded.model === 'Model Y' || carType === 'modely' || isJuniperCarType) {

      const mt = motorType?.toLowerCase() ?? '';
      const isPerf  = drive === 'F' || drive === 'L' || badge.includes('perf') || badge === 'p74d'
                   || mt.includes('performance');
      const isLrAwd = drive === 'E' || drive === 'K' || badge === '75d' || badge === 'awd'
                   || badge.includes('long_range_awd') || badge === 'lrawd'
                   || mt.includes('dual');
      const isLrRwd = drive === 'G' || drive === 'R' || drive === 'D' || drive === 'S'
                   || badge === '74d' || badge.includes('long_range_rwd') || badge === 'lrrwd'
                   || (!isPerf && !isLrAwd && mt.includes('rear'));
      // Standard RWD only exists in Juniper (LFP, added Oct 2025)
      const isStdRwd = badge.includes('standard') || badge === 'sr' || badge.includes('entry');

      // Determine generation
      const isJuniperByDate = mfgYear != null && (mfgYear > 2025 || (mfgYear === 2025 && (mfgMonth ?? 0) >= 1));
      const isJuniperByTrim = yr >= 2025 && (isLrAwd || isPerf);  // these trims only exist as Juniper in 2025
      if (isJuniperCarType || yr >= 2026 || isJuniperByTrim || isJuniperByDate) {
        generation = 'Juniper';
      }
      // LR RWD + yr 2025 + no manufactureDate → stays null (genuinely ambiguous)

      const isNewPack = yr >= 2022;  // 2020-2021 had smaller 75 kWh pack

      if (isPerf) {
        driveType   = 'AWD';
        trim        = 'Performance AWD';
        modelCode   = generation === 'Juniper' ? 'modely2_performance' : 'modely_performance';
        displayName = generation === 'Juniper' ? 'Model Y Performance (Juniper)' : 'Model Y Performance';
        if (generation === 'Juniper') {
          setPack(83, 79, 580, 250);
        } else {
          setPack(isNewPack ? 82 : 75, isNewPack ? 78 : 72, isNewPack ? 514 : 481, 250);
        }
      } else if (isLrAwd) {
        driveType   = 'AWD';
        trim        = 'Long Range AWD';
        modelCode   = generation === 'Juniper' ? 'modely2_premium_awd' : 'modely_lr_awd';
        displayName = generation === 'Juniper' ? 'Model Y Premium AWD (Juniper)' : 'Model Y Long Range AWD';
        if (generation === 'Juniper') {
          setPack(83, 79, 600, 250);
        } else {
          setPack(isNewPack ? 82 : 75, isNewPack ? 78 : 72, isNewPack ? 533 : 507, 250);
        }
      } else if (isStdRwd) {
        // Standard RWD is Juniper-only (LFP, 175 kW DC, launched Oct 2025)
        generation  = 'Juniper';
        driveType   = 'RWD';
        trim        = 'Standard RWD';
        modelCode   = 'modely2_standard_rwd';
        displayName = 'Model Y Standard RWD (Juniper)';
        setPack(68, 64.5, 534, 175, 'LFP');
      } else if (isLrRwd) {
        driveType   = 'RWD';
        trim        = 'Long Range RWD';
        modelCode   = generation === 'Juniper' ? 'modely2_premium_rwd' : 'modely_lr_rwd';
        displayName = generation === 'Juniper' ? 'Model Y Premium RWD (Juniper)' : 'Model Y Long Range RWD';
        if (generation === 'Juniper') {
          setPack(83, 79, 609, 250);
        } else {
          setPack(78, 75, 533, 250);
        }
      } else {
        // Legacy Standard Range (LFP)
        driveType   = 'RWD';
        trim        = 'Standard Range';
        modelCode   = 'modely_sr';
        displayName = 'Model Y Standard Range';
        setPack(60, 57, 466, 170, 'LFP');
      }

    // ── Model 3 (all generations) ─────────────────────────────────────────────
    // Highland detection: carType 'model3p' = confirmed; VIN yr ≥ 2024 = safe heuristic
    // (ALL Model 3 sold in EU from 2024 are Highland — unambiguous refresh unlike Model Y)
    } else if (decoded.model === 'Model 3' || carType === 'model3' || isHighlandCarType) {

      if (isHighlandCarType || yr >= 2024) generation = 'Highland';

      const isPerf = drive === 'F' || badge.includes('perf') || badge === 'p3d+';
      const isSr   = badge.includes('sr') || badge.includes('standard') || badge === 'lrrw'
                  || drive === 'R';
      const isHighland = generation === 'Highland';

      if (isPerf) {
        displayName = `Model 3 Performance${isHighland ? ' (Highland)' : ''}`;
        modelCode   = 'model3_performance';
        trim        = 'Performance';
        driveType   = 'AWD';
        setPack(82, isHighland ? 79 : 78, isHighland ? 528 : 498, 250);
      } else if (isSr) {
        const isLfpSr = yr >= 2021 || region === 'EU' || region === 'CN';
        displayName = `Model 3 RWD${isHighland ? ' (Highland)' : ''}`;
        modelCode   = 'model3_rwd';
        trim        = 'Standard Range';
        driveType   = 'RWD';
        if (isLfpSr) {
          setPack(60, 57.5, isHighland ? 513 : 438, 170, 'LFP');
        } else {
          setPack(50, 49, 400, 170, 'NMC');
        }
      } else {
        displayName = `Model 3 Long Range AWD${isHighland ? ' (Highland)' : ''}`;
        modelCode   = 'model3_lr_awd';
        trim        = 'Long Range AWD';
        driveType   = 'AWD';
        if (isHighland) {
          setPack(82, 78, 629, 250);
        } else if (yr >= 2021) {
          setPack(82, 75, 602, 250);
        } else {
          setPack(75, 73.5, 530, 250);
        }
      }

    // ── Model S ──────────────────────────────────────────────────────────────
    // models=Gen1(2012-2015), models2=Gen2(2016-2020), models3=Plaid-era(2021+)
    } else if (decoded.model === 'Model S' || carType === 'models' || carType === 'models2' || carType === 'models3') {
      const isPlaid   = carType === 'models3' || badge.includes('plaid') || drive === 'P';
      const isRefresh = carType === 'models3' || carType === 'models2' || yr >= 2021;

      if (isPlaid) {
        displayName = 'Model S Plaid';
        modelCode   = 'models_plaid';
        trim        = 'Plaid';
        driveType   = 'AWD (Tri-motor)';
        setPack(100, 95, 637, 250);
      } else if (isRefresh || badge.includes('100') || badge === 'long_range') {
        displayName = 'Model S Long Range';
        modelCode   = 'models_lr';
        trim        = 'Long Range';
        driveType   = 'AWD';
        setPack(100, 95, 652, 250);
      } else if (badge.includes('90') || badge === 'p90d' || badge === '90d') {
        displayName = badge === 'p90d' ? 'Model S P90D' : 'Model S 90D';
        modelCode   = badge === 'p90d' ? 'models_p90d' : 'models_90d';
        trim        = badge === 'p90d' ? 'P90D' : '90D';
        driveType   = 'AWD';
        setPack(90, 85.5, null, 120);
      } else if (badge.includes('85')) {
        const isPD = badge === 'p85d' || badge === 'p85';
        displayName = isPD ? 'Model S P85D' : 'Model S 85';
        modelCode   = isPD ? 'models_p85d' : 'models_85';
        trim        = isPD ? 'P85D' : '85';
        driveType   = isPD ? 'AWD' : 'RWD';
        setPack(85, 80.8, null, 120);
      } else if (badge.includes('75')) {
        displayName = 'Model S 75D';
        modelCode   = 'models_75d';
        trim        = '75D';
        driveType   = 'AWD';
        setPack(75, 72.5, null, 100);
      } else if (badge.includes('70')) {
        displayName = 'Model S 70D';
        modelCode   = 'models_70d';
        trim        = '70D';
        driveType   = 'AWD';
        setPack(70, 66.5, null, 100);
      } else {
        // Unknown old variant — fall back to LR spec
        displayName = 'Model S Long Range';
        modelCode   = 'models_lr';
        trim        = 'Long Range';
        driveType   = 'AWD';
        setPack(100, 95, 652, 250);
      }

    // ── Model X ──────────────────────────────────────────────────────────────
    // modelx=Gen1(2015-2020), modelx2=Plaid-era(2021+)
    } else if (decoded.model === 'Model X' || carType === 'modelx' || carType === 'modelx2') {
      const isPlaid   = carType === 'modelx2' || badge.includes('plaid') || drive === 'P';
      const isRefresh = carType === 'modelx2' || yr >= 2021;

      if (isPlaid) {
        displayName = 'Model X Plaid';
        modelCode   = 'modelx_plaid';
        trim        = 'Plaid';
        driveType   = 'AWD (Tri-motor)';
        setPack(100, 95, 543, 250);
      } else if (isRefresh || badge.includes('100') || badge === 'long_range') {
        displayName = 'Model X Long Range';
        modelCode   = 'modelx_lr';
        trim        = 'Long Range';
        driveType   = 'AWD';
        setPack(100, 95, 580, 250);
      } else if (badge.includes('90') || badge === 'p90d' || badge === '90d') {
        displayName = badge === 'p90d' ? 'Model X P90D' : 'Model X 90D';
        modelCode   = badge === 'p90d' ? 'modelx_p90d' : 'modelx_90d';
        trim        = badge === 'p90d' ? 'P90D' : '90D';
        driveType   = 'AWD';
        setPack(90, 85.5, null, 120);
      } else if (badge.includes('100') || badge === 'p100d') {
        displayName = badge === 'p100d' ? 'Model X P100D' : 'Model X 100D';
        modelCode   = badge === 'p100d' ? 'modelx_p100d' : 'modelx_100d';
        trim        = badge === 'p100d' ? 'P100D' : '100D';
        driveType   = 'AWD';
        setPack(100, 95, null, 150);
      } else if (badge.includes('75')) {
        displayName = 'Model X 75D';
        modelCode   = 'modelx_75d';
        trim        = '75D';
        driveType   = 'AWD';
        setPack(75, 72.5, null, 100);
      } else {
        displayName = 'Model X Long Range';
        modelCode   = 'modelx_lr';
        trim        = 'Long Range';
        driveType   = 'AWD';
        setPack(100, 95, 580, 250);
      }

    // ── Cybertruck ────────────────────────────────────────────────────────────
    } else if (decoded.model === 'Cybertruck' || carType === 'cybertruck') {
      const isRwd   = drive === 'R' || badge === 'rwd';
      const isBeast = badge.includes('beast') || badge.includes('cyberbeast');
      displayName   = isBeast ? 'Cybertruck Cyberbeast' : (isRwd ? 'Cybertruck RWD' : 'Cybertruck AWD');
      modelCode     = isBeast ? 'cybertruck_beast' : (isRwd ? 'cybertruck_rwd' : 'cybertruck_awd');
      trim          = isBeast ? 'Cyberbeast' : (isRwd ? 'RWD' : 'AWD');
      driveType     = isBeast ? 'AWD (Tri-motor)' : (isRwd ? 'RWD' : 'AWD');
      // AWD/Beast: 123 kWh nominal / 118 kWh usable; RWD: 100/95 kWh
      setPack(isRwd ? 100 : 123, isRwd ? 95 : 118, null, 350);
    }

    return {
      modelCode,
      displayName,
      region,
      year: decoded.year,
      batteryNominalKwh,
      batteryUsableKwh,
      rangeWltp,
      peakChargingKw,
      cellChemistry,
      generation,
      manufactureDate,
      trim,
      driveType,
    };
  }

  /**
   * Infer deployment region from the WMI (first 3 VIN characters).
   *
   * XP7 = Giga Shanghai, assigned for EU/Asia-Pacific export markets → region EU
   * LRW / SFZ = Giga Shanghai (China domestic market) → region CN
   * 5YJ / 7SA / SFZ = Fremont (US) or Giga Texas → region US
   */
  private inferRegionFromVin(vin: string): string {
    const wmi = vin.slice(0, 3);
    if (wmi.startsWith('5YJ') || wmi.startsWith('7SA') || wmi.startsWith('7G2')) return 'US';
    if (wmi.startsWith('LRW') || wmi.startsWith('SFZ') || wmi.startsWith('LSG')) return 'CN';
    // XP7 = Shanghai for EU export; SB8 = Giga Berlin → both EU spec
    return 'EU';
  }

  /**
   * Ensure VehicleSpec row exists and link it to Vehicle.
   * Also updates Vehicle.batteryCapacity* fields to match detected spec.
   */
  async ensureVehicleSpecForVehicle(vehicleId: string, apiVehicle: any) {
    const vin: string | undefined = apiVehicle?.vin;
    if (!vin) {
      this.logger.warn(
        `ensureVehicleSpecForVehicle: no VIN for vehicle ${vehicleId}, skipping spec detection`,
      );
      return;
    }

    const detected = this.detectFromTeslaPayload(vin, apiVehicle);

    const year = detected.year ?? apiVehicle?.year ?? new Date().getFullYear();

    const spec = await this.prisma.vehicleSpec.upsert({
      where: {
        modelCode_year_region: {
          modelCode: detected.modelCode,
          year,
          region: detected.region,
        },
      },
      create: {
        modelCode:         detected.modelCode,
        displayName:       detected.displayName,
        year,
        region:            detected.region,
        batteryNominalKwh: detected.batteryNominalKwh,
        batteryUsableKwh:  detected.batteryUsableKwh,
        rangeWltp:         detected.rangeWltp,
        rangeEpa:          null,
        rangeNedcKm:       null,
        peakChargingKw:    detected.peakChargingKw,
        cellChemistry:     detected.cellChemistry,
        generation:        detected.generation,
      },
      update: {
        // Always refresh from latest detection — accuracy improves over time
        batteryNominalKwh: detected.batteryNominalKwh,
        batteryUsableKwh:  detected.batteryUsableKwh,
        cellChemistry:     detected.cellChemistry,
        ...(detected.generation     != null ? { generation:     detected.generation     } : {}),
        ...(detected.rangeWltp      != null ? { rangeWltp:      detected.rangeWltp      } : {}),
        ...(detected.peakChargingKw != null ? { peakChargingKw: detected.peakChargingKw } : {}),
      },
    });

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        vehicleSpecId:          spec.id,
        batteryCapacityNominal: detected.batteryNominalKwh,
        batteryCapacityUsable:  detected.batteryUsableKwh,
        trim:                   detected.trim ?? undefined,
        ...(detected.year != null ? { year: detected.year } : {}),
      },
    });

    this.logger.log(
      `Spec attached to ${vehicleId}: ${spec.modelCode} ${year} ${spec.region} ` +
      `(${spec.batteryNominalKwh}/${spec.batteryUsableKwh} kWh, ${detected.cellChemistry}, ` +
      `WLTP=${spec.rangeWltp ?? 'N/A'} km, peak=${spec.peakChargingKw ?? 'N/A'} kW)`,
    );
  }
}
