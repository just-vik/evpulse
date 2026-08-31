import { Injectable, OnModuleInit } from '@nestjs/common';
import { MqttService } from '../mqtt/mqtt.service';
import { TelemetryService } from './telemetry.service';
import { TripDetectorService } from '../trips/trip-detector.service';
import { ChargingDetectorService } from '../charging/charging-detector.service';
import { normalizeTeslaPayload } from '../utils/normalizeTeslaTelemetry';
import PQueue from 'p-queue';
import { TelemetryBufferService } from './telemetry-buffer.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class TelemetryStreamWorker implements OnModuleInit {
  private readonly queue = new PQueue({ concurrency: 5 });

  constructor(
    private readonly mqtt: MqttService,
    private readonly telemetryService: TelemetryService,
    private readonly tripDetector: TripDetectorService,
    private readonly chargingDetector: ChargingDetectorService,
    private readonly telemetryBuffer: TelemetryBufferService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    await this.mqtt.subscribe('telemetry/tesla/+', async (topic, message) => {
      this.queue.add(async () => {
        try {
          const raw = JSON.parse(message.toString());
          const vehicleId = raw.vehicle_id || raw.vehicleId;
          if (!vehicleId) return;

          // Помечаем последнюю streaming-точку для watchdog
          await this.redis.set(
            `stream:last:${vehicleId}`,
            Date.now().toString(),
            'EX',
            600,
          );

          const normalized = normalizeTeslaPayload(raw);

          // Streaming telemetry тоже идёт через общий буфер
          await this.telemetryBuffer.addPoint(vehicleId, {
            ...normalized,
            timestamp: new Date(normalized.timestamp),
          });
        } catch {
          // best-effort: do not crash worker on malformed message
        }
      });
    });
  }
}

