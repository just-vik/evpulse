import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EfficiencyDatasetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Построить датасет для обучения модели эффективности поездок (Wh/km).
   * Возвращает массив трипов с агрегированными фичами.
   */
  async buildDataset(vehicleId: string, limit = 1000) {
    const rows = await this.prisma.$queryRaw`
      SELECT
        t.id                                AS "tripId",
        t."vehicleId"                       AS "vehicleId",
        t."distanceKm"                      AS "distanceKm",
        t."energyUsedKwh"                   AS "energyKwh",
        (t."energyUsedKwh" * 1000) / NULLIF(t."distanceKm", 0) AS "efficiencyWhKm",
        avg(tp.speed)                       AS "avgSpeed",
        max(tp.speed)                       AS "maxSpeed",
        avg(tp."outsideTemp")              AS "avgOutsideTemp"
      FROM trips t
      JOIN telemetry_points tp
        ON tp."vehicleId" = t."vehicleId"
       AND tp."timestamp" BETWEEN t."startTime" AND COALESCE(t."endTime", t."startTime")
      WHERE t."vehicleId" = ${vehicleId}
        AND t."distanceKm" IS NOT NULL
        AND t."distanceKm" > 1
        AND t."energyUsedKwh" IS NOT NULL
      GROUP BY t.id, t."vehicleId", t."distanceKm", t."energyUsedKwh"
      ORDER BY t."startTime" DESC
      LIMIT ${limit};
    `;

    return rows;
  }
}

