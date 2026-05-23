import mqtt, { type MqttClient } from 'mqtt';
import type { StoredConnection } from '../storage/credentials.ts';
import type { ConnectionState, IncomingMessage } from './types.ts';
import type { PublishOpts } from './queue.ts';

export type MessageHandler = (msg: IncomingMessage) => void;
export type StateHandler = (state: ConnectionState, err?: Error) => void;

export class MqttWrapper {
  private client: MqttClient | null = null;
  private onMessage: MessageHandler;
  private onState: StateHandler;
  private currentSubscriptions = new Set<string>();

  constructor(onMessage: MessageHandler, onState: StateHandler) {
    this.onMessage = onMessage;
    this.onState = onState;
  }

  connect(conn: StoredConnection): void {
    if (this.client) return;
    this.onState('connecting');
    const client = mqtt.connect(conn.url, {
      username: conn.username || undefined,
      password: conn.password || undefined,
      protocolVersion: 5,
      clean: true,
      resubscribe: false,
      reconnectPeriod: 1000,
      connectTimeout: 10_000,
    });
    this.client = client;

    client.on('connect', () => {
      this.onState('connected');
      // Slice 1/2: re-issue any active subscriptions on reconnect.
      for (const filter of this.currentSubscriptions) {
        client.subscribe(filter, { qos: 1 });
      }
    });
    client.on('reconnect', () => this.onState('reconnecting'));
    client.on('close', () => {
      if (client.disconnecting || client.disconnected) {
        // keep current state; explicit disconnect path will reset
      } else {
        this.onState('reconnecting');
      }
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

  // Raw publish used by PublishQueue.flush(). The queue is responsible for
  // serializing payloads and selecting the timestamp User Property; this
  // method just hands the byte string to mqtt.js and surfaces the PUBACK.
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
