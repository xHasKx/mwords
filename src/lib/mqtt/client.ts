import mqtt, { type MqttClient } from 'mqtt';
import type { StoredConnection } from '../storage/credentials.ts';
import type { ConnectionState, IncomingMessage } from './types.ts';

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
      // First slice: re-issue any active subscriptions on reconnect.
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

  subscribe(filter: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      this.currentSubscriptions.add(filter);
      this.client.subscribe(filter, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
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

  // First slice: direct publish, no IDB queue. Same signature the queued
  // implementation will swap in for slice 2.
  publishIntent(topic: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      const json = JSON.stringify(payload);
      const updated = typeof (payload as { updated?: unknown }).updated === 'number'
        ? String((payload as { updated: number }).updated)
        : String(Date.now() / 1000);
      this.client.publish(
        topic,
        json,
        {
          qos: 1,
          retain: true,
          properties: { userProperties: { timestamp: updated } },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  publishTombstone(topic: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      const ts = String(Date.now() / 1000);
      this.client.publish(
        topic,
        '',
        {
          qos: 1,
          retain: true,
          properties: { userProperties: { timestamp: ts } },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
