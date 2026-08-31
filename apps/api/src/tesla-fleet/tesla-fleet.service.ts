import { Injectable, Logger, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';
import { Redis } from 'ioredis';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { addTeslaRetryInterceptor } from './tesla-http.config';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { MetricsService } from '../metrics/metrics.service';
import { tracer } from '../otel';

/**
 * TeslaFleetService - Official Tesla Fleet API Integration
 *
 * All URLs come from env vars:
 *   TESLA_API_BASE_URL  — e.g. https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1
 *   TESLA_TOKEN_URL     — e.g. https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token
 *   TESLA_AUTH_URL      — e.g. https://auth.tesla.com/oauth2/v3/authorize
 */
@Injectable()
export class TeslaFleetService {
  private readonly logger = new Logger(TeslaFleetService.name);
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly authUrl: string;
  private readonly proxyBase: string | null;
  // Reusable HTTPS agent that accepts the proxy's self-signed TLS cert
  private readonly proxyAgent = new https.Agent({ rejectUnauthorized: false });

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {
    // Add retry interceptor for rate limiting and transient errors
    addTeslaRetryInterceptor(this.httpService.axiosRef);

    // Global network timeout for all Tesla HTTP calls (hard cap).
    this.httpService.axiosRef.defaults.timeout = 8_000;

    // Start an OTel span for each outgoing Tesla API call.
    // Stored in config metadata so the response interceptor below can end it.
    this.httpService.axiosRef.interceptors.request.use((config) => {
      const endpoint = this.extractTeslaEndpoint(config.url ?? '');
      const span = tracer.startSpan(`tesla.api.${endpoint}`, {
        attributes: {
          'http.method':    (config.method ?? 'GET').toUpperCase(),
          'http.url':       config.url ?? '',
          'tesla.endpoint': endpoint,
        },
      });
      (config as any).__otelSpan = span;
      return config;
    });

    // Count every Tesla API request by normalized endpoint + HTTP status,
    // and end the per-request OTel span started above.
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        const span: Span | undefined = (response.config as any).__otelSpan;
        if (span) {
          span.setAttribute('http.status_code', response.status);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }
        this.metrics.teslaApiRequestsTotal.inc({
          endpoint: this.extractTeslaEndpoint(response.config.url ?? ''),
          status: String(response.status),
        });
        return response;
      },
      (error) => {
        const span: Span | undefined = (error?.config as any)?.__otelSpan;
        if (span) {
          span.setAttribute('http.status_code', error?.response?.status ?? 0);
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          span.end();
        }
        this.metrics.teslaApiRequestsTotal.inc({
          endpoint: this.extractTeslaEndpoint(error?.config?.url ?? ''),
          status: String(error?.response?.status ?? 'ERR'),
        });
        throw error;
      },
    );

    // Strip trailing slash so we can always write `${apiBase}/vehicles`
    this.apiBase = (this.configService.get<string>('TESLA_API_BASE_URL')
      ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1').replace(/\/$/, '');
    this.tokenUrl = this.configService.get<string>('TESLA_TOKEN_URL')
      ?? 'https://auth.tesla.com/oauth2/v3/token';
    this.authUrl = this.configService.get<string>('TESLA_AUTH_URL')
      ?? 'https://auth.tesla.com/oauth2/v3/authorize';

    // Vehicle Command Proxy — signs commands for newer Tesla vehicles (post-2021 BLE firmware).
    // Internal Docker service, self-signed TLS. Falls back to direct API if not configured.
    const proxyUrl = this.configService.get<string>('VEHICLE_COMMAND_PROXY_URL');
    this.proxyBase = proxyUrl ? `${proxyUrl.replace(/\/$/, '')}/api/1` : null;
    if (this.proxyBase) {
      this.logger.log(`Vehicle Command Proxy enabled: ${proxyUrl}`);
    }
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  getAuthorizationUrl(state: string, redirectUri?: string): string {
    const params = new URLSearchParams({
      client_id: this.configService.get('TESLA_CLIENT_ID'),
      redirect_uri: redirectUri ?? this.configService.get('TESLA_REDIRECT_URI'),
      response_type: 'code',
      scope: 'offline_access vehicle_device_data vehicle_commands vehicle_location energy_device_data',
      state,
    });
    return `${this.authUrl}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<any>(this.tokenUrl, {
          grant_type: 'authorization_code',
          code,
          client_id: this.configService.get('TESLA_CLIENT_ID'),
          client_secret: this.configService.get('TESLA_CLIENT_SECRET'),
          redirect_uri: this.configService.get('TESLA_REDIRECT_URI'),
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to exchange code for tokens: ${error.message}`);
      throw new HttpException('Failed to authenticate with Tesla', HttpStatus.UNAUTHORIZED);
    }
  }

  async refreshTokens(refreshToken: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<any>(this.tokenUrl, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.configService.get('TESLA_CLIENT_ID'),
          client_secret: this.configService.get('TESLA_CLIENT_SECRET'),
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to refresh tokens: ${error.message}`);
      throw error;
    }
  }

  // ── Vehicle data ──────────────────────────────────────────────────────────

  async getVehicles(accessToken: string): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(`${this.apiBase}/vehicles`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return response.data.response ?? [];
    } catch (error) {
      this.logger.error(`Failed to fetch vehicles: ${error.message}`);
      throw error;
    }
  }

  /**
   * Lightweight vehicle summary used to check connection state (online/asleep/offline)
   * without hitting the heavy /vehicle_data endpoint.
   */
  async getVehicleSummary(
    teslaVehicleId: string,
    accessToken: string,
  ): Promise<any | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(`${this.apiBase}/vehicles/${teslaVehicleId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return response.data.response ?? null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch vehicle summary for ${teslaVehicleId}: ${error.message}`,
      );
      return null;
    }
  }

  async getVehicleData(
    teslaVehicleId: string,
    accessToken: string,
    options?: { endpoints?: string[] },
  ): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(
          `${this.apiBase}/vehicles/${teslaVehicleId}/vehicle_data`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
              let_it_sleep: true,
              ...(options?.endpoints
                ? { endpoints: options.endpoints.join(';') }
                : {}),
            },
          },
        ),
      );
      return response.data.response;
    } catch (error) {
      this.logger.error(
        `Tesla API error for vehicle ${teslaVehicleId}: ${error.message}`
      )
      return null
    }
  }

  async getChargeState(vehicleId: string, accessToken: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(
          `${this.apiBase}/vehicles/${vehicleId}/data_request/charge_state`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return response.data.response;
    } catch (error) {
      this.logger.error(`Failed to fetch charge state: ${error.message}`);
      throw error;
    }
  }

  async getDriveState(vehicleId: string, accessToken: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(
          `${this.apiBase}/vehicles/${vehicleId}/data_request/drive_state`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return response.data.response;
    } catch (error) {
      this.logger.error(`Failed to fetch drive state: ${error.message}`);
      throw error;
    }
  }

  async getClimateState(vehicleId: string, accessToken: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(
          `${this.apiBase}/vehicles/${vehicleId}/data_request/climate_state`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return response.data.response;
    } catch (error) {
      this.logger.error(`Failed to fetch climate state: ${error.message}`);
      throw error;
    }
  }

  async wakeVehicle(vehicleId: string, accessToken: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<any>(
          `${this.apiBase}/vehicles/${vehicleId}/wake_up`,
          {},
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return response.data.response;
    } catch (error) {
      this.logger.error(`Failed to wake vehicle: ${error.message}`);
      throw error;
    }
  }

  // ── Fleet Telemetry configuration ──────────────────────────────────────────

  /**
   * Configure Tesla Fleet Telemetry to push streaming data to our webhook.
   * See Tesla Fleet Telemetry docs for full payload capabilities.
   */
  async configureTelemetry(
    accessToken: string,
    options: {
      vins: string[];
      hostname: string;
      port?: number;
    },
  ): Promise<any> {
    // Body format required by the Vehicle Command Proxy (proxy.handleFleetTelemetryConfig):
    // { vins: string[], config: jwt.MapClaims }
    // Proxy signs config, then POSTs { vins, token } to /api/1/vehicles/fleet_telemetry_config_jws
    // CA cert: Tesla verifies our server's TLS cert against this CA.
    // Read from env so it can be updated without a rebuild.
    // CA cert: required by Tesla to verify our Fleet Telemetry server.
    // Stored as base64 in env to avoid multiline issues; fallback to PEM.
    let caPem = this.configService.get<string>('FLEET_TELEMETRY_CA')?.trim() ?? '';
    if (!caPem) {
      const b64 = this.configService.get<string>('FLEET_TELEMETRY_CA_B64');
      if (b64) caPem = Buffer.from(b64, 'base64').toString('utf8').trim();
    }

    const body: any = {
      vins: options.vins,
      config: {
        hostname: options.hostname,
        port: options.port ?? 443,
        ca: caPem || undefined,
        // prefer_typed: true enables typed proto values (required for minimum_delta, firmware ≥ 2024.44.32)
        prefer_typed: true,
        fields: {
          // ── Driving / motion ──────────────────────────────────────────────
          VehicleSpeed:         { interval_seconds: 5,  minimum_delta: 2   }, // km/h
          Location:             { interval_seconds: 5,  minimum_delta: 10  }, // metres
          GpsHeading:           { interval_seconds: 5,  minimum_delta: 5   }, // degrees
          Odometer:             { interval_seconds: 30, minimum_delta: 0.1 }, // km
          // Gear — 1s for accurate trip start/end detection
          Gear:                 { interval_seconds: 1  },
          // ── Pack data (drive power = -V×I) ────────────────────────────────
          PackVoltage:          { interval_seconds: 10, minimum_delta: 1   }, // V
          PackCurrent:          { interval_seconds: 10, minimum_delta: 2   }, // A
          // ── Battery ───────────────────────────────────────────────────────
          Soc:                  { interval_seconds: 30, minimum_delta: 1   }, // % — saves ~20x signals at rest
          UsableBatteryLevel:   { interval_seconds: 30, minimum_delta: 1   }, // user-visible SOC (excludes buffer)
          BatteryLevel:         { interval_seconds: 60, minimum_delta: 1   },
          EstBatteryRange:      { interval_seconds: 60, minimum_delta: 1   }, // km estimated range
          RatedRange:           { interval_seconds: 60, minimum_delta: 1   },
          // ── Charging ─────────────────────────────────────────────────────
          ChargeState:          { interval_seconds: 10 },
          // ChargeEnergyAdded / DCChargingCurrent / DCChargingVoltage / DetailedChargeState:
          // removed — EU Fleet API returns 400 "Unknown field" for these.
          // Energy is derived from power×Δt + REST charge_energy_added; V/I redundant given kW fields.
          DCChargingPower:      { interval_seconds: 10, minimum_delta: 1   }, // kW
          ACChargingPower:      { interval_seconds: 10, minimum_delta: 1   }, // kW
          ChargerVoltage:       { interval_seconds: 10, minimum_delta: 2.0 }, // V
          ChargeAmps:           { interval_seconds: 10, minimum_delta: 1.0 }, // A
          FastChargerType:      { interval_seconds: 30 },                      // supercharger type detection
          // FastChargerBrand: removed — EU Fleet API returns 400 "Unknown field"
          // ── Security / access ─────────────────────────────────────────────
          Locked:               { interval_seconds: 1  },
          DoorState:            { interval_seconds: 1  },
          SentryMode:           { interval_seconds: 30 },
          // ── Climate ───────────────────────────────────────────────────────
          InsideTemp:           { interval_seconds: 30, minimum_delta: 0.5 }, // °C
          OutsideTemp:          { interval_seconds: 60, minimum_delta: 1   }, // °C
          HvacPower:            { interval_seconds: 30, minimum_delta: 50  }, // W — >50 W = climate on
          // ── Tyres ─────────────────────────────────────────────────────────
          TpmsPressureFl:       { interval_seconds: 60, minimum_delta: 0.1 }, // bar
          TpmsPressureFr:       { interval_seconds: 60, minimum_delta: 0.1 },
          TpmsPressureRl:       { interval_seconds: 60, minimum_delta: 0.1 },
          TpmsPressureRr:       { interval_seconds: 60, minimum_delta: 0.1 },
        },
        // Service alerts: vehicle maintenance, safety, and software notices.
        // "service" covers tyre pressure, brake fluid, door-ajar, battery warnings.
        alert_types: ['service'],
      },
    };

    try {
      // fleet_telemetry_config MUST go through the Vehicle Command Proxy — Tesla requires
      // the request to be signed with the registered fleet private key.
      const base = this.proxyBase ?? this.apiBase;
      const extraConfig = this.proxyBase ? { httpsAgent: this.proxyAgent } : {};
      const response = await firstValueFrom(
        this.httpService.post<any>(
          `${base}/vehicles/fleet_telemetry_config`,
          body,
          { headers: { Authorization: `Bearer ${accessToken}` }, ...extraConfig },
        ),
      );
      this.logger.log(`Fleet telemetry configured for ${options.vins.join(', ')}`);

      // Fire-and-forget sync check per VIN — logs result, never blocks caller
      for (const vin of options.vins) {
        this.waitForTelemetrySynced(vin, accessToken).catch(() => {});
      }

      return response.data;
    } catch (error: any) {
      const status = error?.response?.status ?? HttpStatus.BAD_GATEWAY;
      const data = error?.response?.data;

      this.logger.error(
        `Failed to configure Tesla Fleet telemetry: ${error.message}` +
        (status ? ` (Tesla status=${status})` : '') +
        (data ? ` payload=${JSON.stringify(data)}` : ''),
      );

      throw new HttpException(
        {
          message: 'Failed to configure Tesla Fleet telemetry',
          teslaStatus: status,
          teslaError: data,
        },
        status === 400 ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private extractTeslaError(error: any): { message: string; status: number; rawBody?: unknown } {
    const status = Number(error?.response?.status ?? error?.status ?? 500);
    const body = error?.response?.data;

    const candidates: unknown[] = [
      body?.error_description,
      body?.error,
      body?.message,
      body?.response?.reason,
      body?.response?.message,
      body?.response?.error,
      typeof body === 'string' ? body : null,
      error?.message,
    ];

    const message = candidates
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0)
      ?? `Tesla command failed (status ${status})`;

    return { message, status, rawBody: body };
  }

  private async postCommand(
    base: string,
    vehicleId: string,
    command: string,
    params: any,
    accessToken: string,
    useProxyTls: boolean,
  ): Promise<any> {
    const extraConfig = useProxyTls ? { httpsAgent: this.proxyAgent } : {};
    const response = await firstValueFrom(
      this.httpService.post<any>(
        `${base}/vehicles/${vehicleId}/command/${command}`,
        params,
        { headers: { Authorization: `Bearer ${accessToken}` }, ...extraConfig },
      ),
    );

    const result = response.data?.response ?? response.data;
    if (result && typeof result === 'object' && result.result === false) {
      const reason: string = (result.reason ?? '').toString().trim() || 'Command rejected by vehicle';
      throw Object.assign(new Error(reason), { status: Number(response.status ?? 400) });
    }
    return result;
  }

  private async sendCommand(vehicleId: string, command: string, params: any = {}, accessToken: string): Promise<any> {
    // Prefer Vehicle Command Proxy when configured, but gracefully fallback to direct Tesla API
    // if proxy returns malformed/empty errors or transient command routing failures.
    let proxyVehicleRef = vehicleId;
    const shouldUseProxyFirst = !!this.proxyBase;
    if (shouldUseProxyFirst && vehicleId.length !== 17) {
      // Proxy expects VIN in path for signed command endpoints.
      const summary = await this.getVehicleSummary(vehicleId, accessToken);
      const vin = typeof summary?.vin === 'string' ? summary.vin.trim() : '';
      if (vin.length === 17) {
        proxyVehicleRef = vin;
      } else {
        this.logger.warn(
          `Could not resolve VIN for command ${command}; using fallback path with vehicleId=${vehicleId}`,
        );
      }
    }

    const primaryBase = this.proxyBase ?? this.apiBase;
    try {
      return await this.postCommand(
        primaryBase,
        shouldUseProxyFirst ? proxyVehicleRef : vehicleId,
        command,
        params,
        accessToken,
        shouldUseProxyFirst,
      );
    } catch (error: any) {
      const first = this.extractTeslaError(error);

      if (shouldUseProxyFirst) {
        this.logger.warn(
          `Command ${command} via proxy failed for vehicle ${vehicleId}: ${first.message}. Trying direct Tesla API fallback...`,
        );
        try {
          return await this.postCommand(
            this.apiBase,
            vehicleId,
            command,
            params,
            accessToken,
            false,
          );
        } catch (fallbackError: any) {
          const second = this.extractTeslaError(fallbackError);
          this.logger.error(
            `Command ${command} failed for vehicle ${vehicleId}: proxy="${first.message}", direct="${second.message}"`,
          );
          const enriched = new Error(second.message || first.message);
          (enriched as any).status = second.status || first.status || 500;
          throw enriched;
        }
      }

      this.logger.error(`Command ${command} failed for vehicle ${vehicleId}: ${first.message}`);
      const enriched = new Error(first.message);
      (enriched as any).status = first.status;
      throw enriched;
    }
  }

  async lockVehicle(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'door_lock', {}, accessToken); }
  async unlockVehicle(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'door_unlock', {}, accessToken); }
  async startCharging(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'charge_start', {}, accessToken); }
  async stopCharging(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'charge_stop', {}, accessToken); }

  async setChargeLimit(vehicleId: string, percent: number, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_charge_limit', { percent }, accessToken);
  }

  async setClimate(vehicleId: string, driverTemp: number, passengerTemp: number, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_temps', { driver_temp: driverTemp, passenger_temp: passengerTemp }, accessToken);
  }

  async startClimate(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'auto_conditioning_start', {}, accessToken); }
  async stopClimate(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'auto_conditioning_stop', {}, accessToken); }
  async flashLights(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'flash_lights', {}, accessToken); }
  async honkHorn(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'honk_horn', {}, accessToken); }
  async openFrunk(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'trunk_open', { which_trunk: 'front' }, accessToken); }
  async openTrunk(vehicleId: string, accessToken: string) { return this.sendCommand(vehicleId, 'trunk_open', { which_trunk: 'rear' }, accessToken); }

  // Windows: vent=small gap to cool down, close=seal shut.
  // close requires lat/lon for vehicle proximity validation.
  async ventWindows(vehicleId: string, accessToken: string) {
    return this.windowControl(vehicleId, 'vent', accessToken);
  }
  async closeWindows(vehicleId: string, accessToken: string) {
    return this.windowControl(vehicleId, 'close', accessToken);
  }

  private async windowControl(vehicleId: string, command: 'vent' | 'close', accessToken: string) {
    let lat = 0, lon = 0;
    try {
      const raw = await this.redis.get(`vehicle:location:${vehicleId}`);
      if (raw) {
        const loc = JSON.parse(raw) as { lat: number; lon: number };
        lat = loc.lat ?? 0;
        lon = loc.lon ?? 0;
      }
    } catch {
      this.logger.warn(`window_control: failed to read cached location for ${vehicleId}, using (0,0)`);
    }
    return this.sendCommand(vehicleId, 'window_control', { command, lat, lon }, accessToken);
  }

  // Charging amps: 0–48A. 0 = pause (some firmware). Useful for tariff-based load management.
  async setChargingAmps(vehicleId: string, amps: number, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_charging_amps', { charging_amps: amps }, accessToken);
  }

  // Sentry mode: on=armed (records threats), off=disarmed.
  async setSentryMode(vehicleId: string, on: boolean, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_sentry_mode', { on }, accessToken);
  }

  // Scheduled charging: time in minutes from midnight (e.g. 360 = 06:00).
  async setScheduledCharging(vehicleId: string, enabled: boolean, timeMinutes: number, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_scheduled_charging', { enable: enabled, time: timeMinutes }, accessToken);
  }

  // Scheduled departure preconditioning: reduces morning charge time via off-peak scheduling.
  async setScheduledDeparture(
    vehicleId: string,
    enabled: boolean,
    departureTimeMinutes: number,
    accessToken: string,
  ) {
    return this.sendCommand(vehicleId, 'set_scheduled_departure', {
      enable:          enabled,
      departure_time:  departureTimeMinutes,
      preconditioning_enabled: enabled,
      preconditioning_weekdays_only: false,
      off_peak_charging_enabled: enabled,
      off_peak_charging_weekdays_only: false,
      end_off_peak_time: departureTimeMinutes,
    }, accessToken);
  }

  // Seat heater: seat 0=driver, 1=passenger, 2-5=rear. level 0-3.
  async setSeatHeater(vehicleId: string, seat: number, level: number, accessToken: string) {
    return this.sendCommand(vehicleId, 'remote_seat_heater_request', { heater: seat, level }, accessToken);
  }

  // Cabin overheat protection: on/off and optional max temp.
  async setCabinOverheatProtection(vehicleId: string, on: boolean, fanOnly: boolean, accessToken: string) {
    return this.sendCommand(vehicleId, 'set_cabin_overheat_protection', { on, fan_only: fanOnly }, accessToken);
  }

  // Remote start: requires current account password. Allows drive without key for ~2 min.
  async startVehicle(vehicleId: string, password: string, accessToken: string) {
    return this.sendCommand(vehicleId, 'remote_start_drive', { password }, accessToken);
  }

  // ── Fleet Telemetry config status ─────────────────────────────────────────

  /**
   * GET /api/1/vehicles/{id}/fleet_telemetry_config
   * Returns synced status for a specific vehicle's telemetry config.
   */
  async getFleetTelemetryConfig(vehicleId: string, accessToken: string): Promise<any> {
    const response = await firstValueFrom(
      this.httpService.get<any>(
        `${this.apiBase}/vehicles/${vehicleId}/fleet_telemetry_config`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
    );
    return response.data?.response ?? response.data;
  }

  /**
   * Poll until the vehicle's telemetry config shows synced: true.
   * Call this in the background after configureTelemetry to confirm the car received the config.
   * Returns true when synced, false on timeout (60 s).
   */
  async waitForTelemetrySynced(
    vehicleId: string,
    accessToken: string,
    maxAttempts = 12,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const cfg = await this.getFleetTelemetryConfig(vehicleId, accessToken);
        if (cfg?.synced === true) {
          this.logger.log(`Fleet telemetry config synced for vehicle ${vehicleId}`);
          return true;
        }
        if (cfg?.limit_reached) {
          throw new Error('Max 3 fleet telemetry configs per vehicle reached');
        }
      } catch (err: any) {
        this.logger.warn(`waitForTelemetrySynced attempt ${i + 1} failed for ${vehicleId}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    this.logger.warn(`Fleet telemetry config not synced after ${maxAttempts * 5}s for vehicle ${vehicleId}`);
    return false;
  }

  /**
   * Fetch the intermediate CA cert from a live TLS handshake.
   * Returns the second cert in the chain (issuing CA), which Tesla uses to verify our server.
   */
  private async fetchIntermediateCert(hostname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const tls = require('tls');
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
        const chain = socket.getPeerCertificate(true);
        socket.destroy();
        // Walk to issuer cert
        const issuer = chain?.issuerCertificate;
        if (!issuer || !issuer.raw) return resolve('');
        const raw = issuer.raw as Buffer;
        const pem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
        resolve(pem);
      });
      socket.on('error', reject);
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')); });
    });
  }

  // ── Charging History (billing) ────────────────────────────────────────────

  /**
   * GET /api/1/vehicles/{id}/nearby_charging_sites
   * Returns nearby Supercharger stations with pricing data.
   * Cost: $0.10 per call — must be cached aggressively.
   */
  async getNearbySuperchargers(vehicleId: string, accessToken: string): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<any>(
          `${this.apiBase}/vehicles/${vehicleId}/nearby_charging_sites`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      const data = response.data?.response ?? response.data;
      // API returns { superchargers: [], destination_charging: [] }
      const superchargers = data?.superchargers ?? data?.nearby_superchargers ?? [];
      return Array.isArray(superchargers) ? superchargers : [];
    } catch (error: any) {
      this.logger.warn(`nearby_charging_sites failed for ${vehicleId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch Tesla billing charging history via /api/1/dx/charging/history
   * Returns real per-session cost, kWh, tariff and location from Tesla billing.
   * Note: Tesla updates history with a 5–15 minute delay after session end.
   */
  async getChargingHistory(
    accessToken: string,
    params: {
      vin: string;
      startTime: string; // ISO 8601
      endTime: string;   // ISO 8601
    },
  ): Promise<any[]> {
    try {
      const url = `${this.apiBase}/dx/charging/history`;
      const response = await firstValueFrom(
        this.httpService.get<any>(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'x-tesla-user-agent': 'TeslaApp/4.30.0',
          },
          params: {
            vin: params.vin,
            startTime: params.startTime,
            endTime: params.endTime,
          },
          timeout: 15_000,
        }),
      );

      const data = response.data;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.response)) return data.response;
      if (Array.isArray(data?.data)) return data.data;
      return [];
    } catch (error: any) {
      const status = error?.response?.status;
      // 403 = billing scope not granted; 404/501 = endpoint not available
      if (status === 403) {
        const err = new Error(`BILLING_SCOPE_MISSING`);
        (err as any).status = 403;
        throw err;
      }
      if (status === 404 || status === 501 || status === 400) {
        this.logger.debug(`Charging history API not available: ${status}`);
        return [];
      }
      this.logger.warn(`Charging history fetch failed: ${error.message}`);
      return [];
    }
  }

  private extractTeslaEndpoint(url: string): string {
    try {
      const path = new URL(url).pathname;
      // Collapse vehicle VINs and numeric IDs to keep label cardinality low.
      // e.g. /api/1/vehicles/5YJ3E1/vehicle_data → /vehicles/:id/vehicle_data
      return path
        .replace(/\/api\/1/, '')
        .replace(/\/[A-Z0-9]{17}(?=\/|$)/, '/:vin')  // VIN (17 chars)
        .replace(/\/\d+(?=\/|$)/g, '/:id');           // numeric IDs
    } catch {
      return 'unknown';
    }
  }
}
