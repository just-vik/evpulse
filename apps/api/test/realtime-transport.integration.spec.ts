import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';

// Cross-process delivery: an emitter publishes into Redis (as the worker does) and the
// Socket.IO server with the Redis adapter (as the api does) fans it out to clients in
// the room. The emitter never touches the io server object, so the only path is Redis.
// Runs only when a Redis instance is configured: REDIS_HOST (+ REDIS_PORT, REDIS_PASSWORD).
const REDIS_HOST = process.env.REDIS_HOST;
const describeWithRedis = REDIS_HOST ? describe : describe.skip;

describeWithRedis('realtime transport: worker emit → api Socket.IO → browser room', () => {
  const redisConfig = {
    host: REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };

  let http: HttpServer;
  let io: Server;
  let apiPub: Redis;
  let apiSub: Redis;
  let workerRedis: Redis;
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
    apiPub = new Redis(redisConfig);
    apiSub = new Redis(redisConfig);
    workerRedis = new Redis(redisConfig);

    http = createServer();
    io = new Server(http);
    io.adapter(createAdapter(apiPub, apiSub));
    io.of('/telemetry').on('connection', (socket) => {
      socket.on('subscribe', (vehicleId: string, ack: () => void) => {
        socket.join(`vehicle:${vehicleId}`);
        ack();
      });
    });
    await new Promise<void>((resolve) => http.listen(0, () => resolve()));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    await new Promise<void>((resolve) => io.close(() => resolve()));
    workerRedis.disconnect();
    apiPub.disconnect();
    apiSub.disconnect();
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
});
