import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';
import type { Server } from 'socket.io';
import { Emitter } from '@socket.io/redis-emitter';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import { RedisIoAdapter } from '../src/websockets/redis-io.adapter';

// Production topology, with the real classes: the api side is RedisIoAdapter's Socket.IO
// server, the worker side is an emitter-only publisher on its own Redis connection, Redis
// is the broker, and the clients are ordinary socket.io-client sockets. The emitter never
// touches the server object, so a delivered event proves it went through Redis.
// Runs only when a Redis instance is configured: REDIS_HOST (+ REDIS_PORT, REDIS_PASSWORD).
const REDIS_HOST = process.env.REDIS_HOST;
const describeWithRedis = REDIS_HOST ? describe : describe.skip;

describeWithRedis('realtime transport: worker emit → api Socket.IO → browser room', () => {
  const redisConfig = {
    host: REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };

  let apiRedis: Redis;
  let workerRedis: Redis;
  let adapter: RedisIoAdapter;
  let server: Server;
  let port: number;
  const clients: ClientSocket[] = [];

  function joinedClient(vehicleId: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = connect(`http://localhost:${port}/telemetry`, {
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(client);
      client.on('connect_error', reject);
      client.on('connect', () => {
        client.emit('subscribe', vehicleId, () => resolve(client));
      });
    });
  }

  beforeAll(async () => {
    jest.setTimeout(20_000);
    apiRedis = new Redis(redisConfig);
    workerRedis = new Redis(redisConfig);

    adapter = new RedisIoAdapter(undefined as any, apiRedis);
    await adapter.connectToRedis();
    // Port 0 without an attached HTTP server: socket.io opens its own listener.
    server = adapter.createIOServer(0) as Server;
    const httpServer = (server as unknown as { httpServer: HttpServer }).httpServer;
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.once('listening', () => resolve()));
    }
    port = (httpServer.address() as AddressInfo).port;
    server.of('/telemetry').on('connection', (socket) => {
      socket.on('subscribe', (vehicleId: string, ack: () => void) => {
        socket.join(`vehicle:${vehicleId}`);
        ack();
      });
    });
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    await adapter.close(server);
    workerRedis.disconnect();
    apiRedis.disconnect();
  });

  it('delivers a worker-published trip event to the client joined to that vehicle room', async () => {
    const client = await joinedClient('veh-1');
    const received = new Promise<unknown>((resolve) => client.on('trip:ended', resolve));

    new Emitter(workerRedis).of('/telemetry').to('vehicle:veh-1').emit('trip:ended', {
      vehicleId: 'veh-1',
      trip: { id: 'trip-1' },
    });

    await expect(received).resolves.toEqual({ vehicleId: 'veh-1', trip: { id: 'trip-1' } });
  });

  it('does not deliver to a client joined to a different vehicle room', async () => {
    const inRoom = await joinedClient('veh-1');
    const otherRoom = await joinedClient('veh-2');
    const otherGot: unknown[] = [];
    otherRoom.on('trip:ended', (payload) => otherGot.push(payload));
    const inRoomGot = new Promise<unknown>((resolve) => inRoom.on('trip:ended', resolve));

    new Emitter(workerRedis).of('/telemetry').to('vehicle:veh-1').emit('trip:ended', {
      vehicleId: 'veh-1',
      trip: { id: 'trip-2' },
    });

    await inRoomGot;
    expect(otherGot).toEqual([]);
  });

  it('api-originated emit (the local path through the same adapter) reaches the room exactly once', async () => {
    const client = await joinedClient('veh-3');
    const got: unknown[] = [];
    client.on('vehicle:update', (payload) => got.push(payload));

    server.of('/telemetry').to('vehicle:veh-3').emit('vehicle:update', { data: { state: 'parked' } });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(got).toEqual([{ data: { state: 'parked' } }]);
  });
});
