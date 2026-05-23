import mqtt, { type MqttClient } from 'mqtt';
import type { StoredConnection } from '../storage/credentials.ts';
import type { ConnectionState, IncomingMessage } from './types.ts';
import type { PublishOpts } from './queue.ts';

export type MessageHandler = (msg: IncomingMessage) => void;
export type StateHandler = (state: ConnectionState, err?: Error) => void;
export type NextAttemptHandler = (nextAttemptAt: number | null) => void;

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

export class MqttWrapper {
  private client: MqttClient | null = null;
  private onMessage: MessageHandler;
  private onState: StateHandler;
  private onNextAttempt: NextAttemptHandler | null;
  private currentSubscriptions = new Set<string>();
  private nextBackoff = MIN_BACKOFF;

  constructor(
    onMessage: MessageHandler,
    onState: StateHandler,
    onNextAttempt?: NextAttemptHandler,
  ) {
    this.onMessage = onMessage;
    this.onState = onState;
    this.onNextAttempt = onNextAttempt ?? null;
  }

  connect(conn: StoredConnection): void {
    if (this.client) return;
    this.onState('connecting');
    this.nextBackoff = MIN_BACKOFF;
    const client = mqtt.connect(conn.url, {
      username: conn.username || undefined,
      password: conn.password || undefined,
      protocolVersion: 5,
      clean: true,
      resubscribe: false,
      reconnectPeriod: MIN_BACKOFF,
      connectTimeout: 10_000,
    });
    this.client = client;

    client.on('connect', () => {
      // Reset both fields — mqtt.js consumes `reconnectPeriod` between
      // `close` and the next `reconnect` event, so resetting only the
      // local mirror leaves a stale period in effect for the first
      // post-reconnect wait.
      this.nextBackoff = MIN_BACKOFF;
      client.options.reconnectPeriod = MIN_BACKOFF;
      this.onNextAttempt?.(null);
      // No auto-re-issue of subscriptions — AppStore.afterConnect drives
      // all (re)subscriptions through subscribeAndSync so the 500 ms
      // debounce applies on every connect, and we don't double-subscribe
      // phase-1 on reconnect.
      this.onState('connected');
    });
    client.on('reconnect', () => {
      // mqtt.js is actively dialing now — clear the countdown target,
      // and bump backoff for the *next* failed wait (mqtt.js consumed
      // the current `reconnectPeriod` before firing this event).
      const jittered = this.nextBackoff * 2 * (0.8 + Math.random() * 0.4);
      this.nextBackoff = Math.min(MAX_BACKOFF, Math.round(jittered));
      client.options.reconnectPeriod = this.nextBackoff;
      this.onNextAttempt?.(null);
      this.onState('reconnecting');
    });
    client.on('close', () => {
      if (client.disconnecting || client.disconnected) return;
      // Close after a connect — mqtt.js will wait `reconnectPeriod` ms
      // before firing `reconnect`. Surface the countdown target.
      this.onNextAttempt?.(Date.now() + this.nextBackoff);
      this.onState('reconnecting');
    });
    client.on('error', (err) => this.onState('error', err));
    client.on('message', (topic, payload, packet) => {
      const up = (packet.properties?.userProperties ?? {}) as Record<string, string | string[]>;
      const tsRaw = up.timestamp;
      const ts = Array.isArray(tsRaw) ? tsRaw[0] : tsRaw;
      this.onMessage({ topic, payload: new Uint8Array(payload), timestampUP: ts });
    });
  }

  disconnect(): void {
    const c = this.client;
    if (!c) return;
    this.client = null;
    this.currentSubscriptions.clear();
    this.onNextAttempt?.(null);
    c.end(true);
    this.onState('idle');
  }

  subscribeMany(filters: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      for (const f of filters) this.currentSubscriptions.add(f);
      this.client.subscribe(filters, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  unsubscribeMany(filters: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      for (const f of filters) this.currentSubscriptions.delete(f);
      this.client.unsubscribe(filters, (err) => (err ? reject(err) : resolve()));
    });
  }

  publishRaw(
    topic: string,
    data: string,
    opts: PublishOpts,
    cb: (err?: Error) => void,
  ): void {
    if (!this.client) {
      cb(new Error('not connected'));
      return;
    }
    this.client.publish(
      topic,
      data,
      {
        qos: opts.qos,
        retain: opts.retain,
        properties: { userProperties: opts.userProperties },
      },
      (err) => cb(err ?? undefined),
    );
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
