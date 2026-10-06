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

  constructor(
    app: INestApplicationContext,
    private readonly redis: Redis,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = this.redis.duplicate();
    const subClient = this.redis.duplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
