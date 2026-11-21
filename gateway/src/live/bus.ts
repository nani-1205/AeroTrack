// Fan-out of tracking-service position batches (Redis pub/sub `trk:pos:{ICAO}`) to sockets.
// One shared subscriber connection; channels are reference-counted across clients.
import type { Redis } from 'ioredis';

export type Unsubscribe = () => Promise<void>;

export interface PositionBus {
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<Unsubscribe>;
}

export class RedisPositionBus implements PositionBus {
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  /** `subscriber` must be a dedicated connection (a subscribed ioredis client can't run other commands). */
  constructor(private readonly subscriber: Redis) {
    subscriber.on('message', (channel: string, payload: string) => {
      for (const handler of this.handlers.get(channel) ?? []) handler(payload);
    });
  }

  async subscribe(channel: string, onMessage: (payload: string) => void): Promise<Unsubscribe> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(onMessage);
    return async () => {
      const current = this.handlers.get(channel);
      if (!current?.delete(onMessage) || current.size > 0) return;
      this.handlers.delete(channel);
      await this.subscriber.unsubscribe(channel);
    };
  }

  /** Number of channels currently subscribed (metrics/tests). */
  get channels(): number {
    return this.handlers.size;
  }
}

/** In-process bus for tests. */
export class MemoryPositionBus implements PositionBus {
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();

  async subscribe(channel: string, onMessage: (payload: string) => void): Promise<Unsubscribe> {
    const set = this.handlers.get(channel) ?? new Set();
    this.handlers.set(channel, set);
    set.add(onMessage);
    return async () => {
      set.delete(onMessage);
    };
  }

  publish(channel: string, payload: unknown): void {
    for (const h of this.handlers.get(channel) ?? []) h(JSON.stringify(payload));
  }

  listeners(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }
}
