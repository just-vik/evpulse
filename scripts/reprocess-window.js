/* eslint-disable no-console */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { PrismaService } = require('./dist/prisma/prisma.service');
const { TripBackfillService } = require('./dist/trips/trip-backfill.service');
const { TripGapRecoveryService } = require('./dist/trips/trip-gap-recovery.service');
const { TripPostProcessorService } = require('./dist/trips/trip-post-processor.service');
const { TelemetryGateway } = require('./dist/websockets/telemetry.gateway');
const Redis = require('ioredis');

async function main() {
  const fromIso = process.argv[2];
  const toIso = process.argv[3];
  const vehicleId = process.argv[4];
  if (!fromIso || !toIso || !vehicleId) {
    throw new Error('Usage: node /app/reprocess-window.js <fromIso> <toIso> <vehicleId>');
  }
  const from = new Date(fromIso);
  const to = new Date(toIso);

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || '6379'),
    lazyConnect: true,
  });
  await redis.connect();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const backfill = app.get(TripBackfillService);
    const gapRecovery = app.get(TripGapRecoveryService);
    const post = app.get(TripPostProcessorService);
    const gateway = app.get(TelemetryGateway, { strict: false });
    if (gateway) {
      gateway.emitTelemetryUpdate = () => {};
      gateway.emitTripStarted = () => {};
      gateway.emitTripEnded = () => {};
      gateway.emitLiveTripUpdate = () => {};
      gateway.emitTripPoint = () => {};
      gateway.emitVehicleOnline = () => {};
      gateway.emitVehicleStateChange = () => {};
    }

    const before = await prisma.trip.count({
      where: { vehicleId, startTime: { gte: from, lte: to } },
    });
    const existing = await prisma.trip.findMany({
      where: { vehicleId, startTime: { gte: from, lte: to } },
      select: { id: true },
    });
    const ids = existing.map((x) => x.id);
    if (ids.length) {
      await prisma.tripPoint.deleteMany({ where: { tripId: { in: ids } } });
      await prisma.tripStats.deleteMany({ where: { tripId: { in: ids } } });
      await prisma.trip.deleteMany({ where: { id: { in: ids } } });
    }

    await redis.del(`trip:detector:state:${vehicleId}`);
    await redis.del(`trip:state:${vehicleId}`);
    await redis.del(`trip:builder:${vehicleId}`);

    const backfillResult = await backfill.backfillVehicleTrips(vehicleId, from, to);
    const postResult = await post.processUnrated(vehicleId, true);
    const gapResult = await gapRecovery.runManual(vehicleId, 1);

    const after = await prisma.trip.count({
      where: { vehicleId, startTime: { gte: from, lte: to } },
    });
    const sample = await prisma.trip.findMany({
      where: { vehicleId, startTime: { gte: from, lte: to } },
      orderBy: { startTime: 'desc' },
      take: 15,
      select: {
        id: true, startTime: true, endTime: true, distanceKm: true,
        startSoc: true, endSoc: true, repairReason: true,
      },
    });

    console.log(JSON.stringify({
      window: { from: from.toISOString(), to: to.toISOString() },
      vehicleId,
      counts: { before, deleted: ids.length, after },
      backfill: backfillResult,
      postProcess: postResult,
      gapRecovery: gapResult,
      sample,
    }, null, 2));
  } finally {
    await app.close();
    await redis.quit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
