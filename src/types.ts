// src/types.ts
// Central type definitions for HyperSocket.
// Every interface, enum, and type used across the package lives here.
// Think of this as the "blueprint" — no logic, just shape definitions.

// ─── Connection State Machine ─────────────────────────────────────────────────
// A WebSocket connection moves through these states exactly once, in order.
// No state can be skipped. No state can go backwards.
// This prevents bugs like "sending a message on a closing socket".

export enum ConnectionState {
  CONNECTING   = 'CONNECTING',   // TCP connected, waiting for HTTP upgrade
  HANDSHAKING  = 'HANDSHAKING',  // Upgrade request received, sending 101
  OPEN         = 'OPEN',         // Handshake done, frames flowing freely
  CLOSING      = 'CLOSING',      // Close frame sent/received, draining
  CLOSED       = 'CLOSED',       // TCP socket fully destroyed
}

// ─── Opcodes ──────────────────────────────────────────────────────────────────
// RFC 6455 §5.2 — the 4-bit opcode field in every frame header.

export enum Opcode {
  CONTINUATION = 0x0,
  TEXT         = 0x1,  // UTF-8 text payload
  BINARY       = 0x2,  // raw binary payload (file transfer, ArrayBuffer)
  CLOSE        = 0x8,  // graceful shutdown — payload has status code + reason
  PING         = 0x9,  // heartbeat probe from either side
  PONG         = 0xa,  // heartbeat reply — MUST echo ping payload
}

// ─── Close Codes ─────────────────────────────────────────────────────────────
// RFC 6455 §7.4 — standard status codes sent in Close frames.
// First 2 bytes of a Close frame payload = uint16 status code.

export enum CloseCode {
  NORMAL        = 1000, // clean shutdown, everything fine
  GOING_AWAY    = 1001, // server shutting down or browser tab closed
  PROTOCOL_ERROR = 1002, // bad frame received
  UNSUPPORTED   = 1003, // received data type we can't handle
  NO_STATUS     = 1005, // reserved — never sent over wire
  ABNORMAL      = 1006, // reserved — connection lost without Close frame
}

// ─── Core Interfaces ──────────────────────────────────────────────────────────

// A decoded WebSocket frame — what codec.ts hands back after parsing raw bytes
export interface HyperFrame {
  fin:     boolean   // is this the final fragment of the message?
  opcode:  Opcode
  masked:  boolean   // true for client→server frames
  payload: Buffer
}

// A parsed, ready-to-use message — what the app layer sees
export interface HyperMessage {
  type:    'text' | 'binary'
  data:    string | Buffer
  from?:   string   // connection ID of sender (set by server)
}

// Options passed to new HyperServer(options)
export interface HyperServerOptions {
  port:              number
  heartbeatInterval?: number  // ms between pings, default 30000
  heartbeatTimeout?:  number  // ms to wait for pong before dropping, default 5000
  maxPayloadSize?:    number  // bytes, default 10MB
}

// Options passed to new HyperClient(url, options)
export interface HyperClientOptions {
  reconnect?:         boolean  // auto-reconnect on disconnect, default true
  reconnectInterval?: number   // initial backoff ms, default 1000
  reconnectMaxDelay?: number   // max backoff ms, default 30000
  maxRetries?:        number   // -1 = infinite, default -1
}

// One active connection tracked by HyperServer
export interface ConnectionInfo {
  id:        string           // random unique ID assigned at upgrade
  state:     ConnectionState
  joinedAt:  Date
  rooms:     Set<string>      // room names this connection has joined
  ip:        string           // remote IP address
}

// Event map — what .on('event', handler) accepts on HyperServer
export interface ServerEvents {
  connection: (conn: ConnectionInfo) => void
  message:    (conn: ConnectionInfo, msg: HyperMessage) => void
  close:      (conn: ConnectionInfo, code: CloseCode, reason: string) => void
  error:      (conn: ConnectionInfo, err: Error) => void
  ping:       (conn: ConnectionInfo) => void
  pong:       (conn: ConnectionInfo) => void
}

// Event map for HyperClient
export interface ClientEvents {
  open:       () => void
  message:    (msg: HyperMessage) => void
  close:      (code: CloseCode, reason: string) => void
  error:      (err: Error) => void
  reconnect:  (attempt: number) => void
}