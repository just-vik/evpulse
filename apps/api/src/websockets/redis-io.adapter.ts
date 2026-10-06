import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type Redis from 'ioredis';

/**
 * Socket.IO server adapter backed by Redis. Only the api process runs a socket
 * server; the worker publishes events through @socket.io/redis-emitter on the same
 * channel, and this adapter fans them out to the browsers joined to each room.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly redis: Redis,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    this.pubClient = this.redis.duplicate();
    this.subClient = this.redis.duplicate();
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }

  async close(server: any): Promise<void> {
    await super.close(server);
    const clients = [this.pubClient, this.subClient];
    this.pubClient = undefined;
    this.subClient = undefined;
    await Promise.all(clients.map((client) => client?.quit().catch(() => undefined)));
  }
}
