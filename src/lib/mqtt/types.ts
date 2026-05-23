export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type IncomingMessage = {
  topic: string;
  payload: Uint8Array;
  timestampUP?: string;
};
