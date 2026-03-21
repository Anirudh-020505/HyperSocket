// src/connection.ts
// Represents a single WebSocket connection on the server side.
// Owns the state machine, frame I/O, ping/pong, and event emission.
// HyperServer creates one of these per TCP socket after upgrade.

import { EventEmitter } from 'events'
import { Socket }       from 'net'
import { randomUUID }   from 'crypto'
import { decodeFrame, encodeFrame } from './codec'
import {
  ConnectionState,
  Opcode,
  CloseCode,
  HyperFrame,
  HyperMessage,
  ConnectionInfo,
} from './types'

export class HyperConnection extends EventEmitter {

  // ─── Identity & State ───────────────────────────────────────────────────
  readonly id:    string          // immutable unique ID
  private state:  ConnectionState
  readonly ip:    string
  readonly rooms: Set<string> = new Set()
  readonly joinedAt = new Date()

  // ─── Internal ───────────────────────────────────────────────────────────
  private socket:      Socket
  private buffer:      Buffer = Buffer.alloc(0)  // incomplete frame accumulator
  private pingTimer?:  NodeJS.Timeout
  private pongTimer?:  NodeJS.Timeout
  private heartbeatInterval: number
  private heartbeatTimeout:  number
  private isAlive = true   // flipped false on ping, true on pong

  constructor(
    socket: Socket,
    opts: { heartbeatInterval: number; heartbeatTimeout: number }
  ) {
    super()
    this.socket             = socket
    this.id                 = randomUUID()
    this.ip                 = socket.remoteAddress ?? 'unknown'
    this.heartbeatInterval  = opts.heartbeatInterval
    this.heartbeatTimeout   = opts.heartbeatTimeout

    // Start in HANDSHAKING — the server already did the HTTP upgrade
    // before constructing this object, so we skip CONNECTING entirely
    this.state = ConnectionState.HANDSHAKING
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  // Called by HyperServer immediately after sending the 101 response.
  // Transitions to OPEN and wires up the socket data events.
  open(): void {
    this.assertState(ConnectionState.HANDSHAKING, 'open')
    this.state = ConnectionState.OPEN

    // Every chunk of raw bytes from the TCP stream lands here.
    // We accumulate into a buffer and pull frames out as they complete.
    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk))

    this.socket.on('end',   () => this.handleSocketEnd())
    this.socket.on('error', (err: Error) => this.emit('error', err))

    // Start the heartbeat loop now that we're OPEN
    this.scheduleHeartbeat()

    this.emit('open')
  }

  // Send a text message to this connection
  send(data: string): void
  // Send a binary message to this connection
  send(data: Buffer): void
  send(data: string | Buffer): void {
    this.assertState(ConnectionState.OPEN, 'send')

    const isBinary = Buffer.isBuffer(data)
    const payload  = isBinary ? data : Buffer.from(data, 'utf8')
    const opcode   = isBinary ? Opcode.BINARY : Opcode.TEXT

    // Server→client frames are NEVER masked (RFC 6455 §5.1)
    const frame = encodeFrame(payload, opcode, false)
    this.socket.write(frame)
  }

  // Gracefully close this connection with a status code and reason string
  close(code: CloseCode = CloseCode.NORMAL, reason = ''): void {
    if (this.state !== ConnectionState.OPEN) return

    this.state = ConnectionState.CLOSING
    this.stopHeartbeat()

    // Build a Close frame: 2-byte big-endian status code + UTF-8 reason
    const reasonBuf   = Buffer.from(reason, 'utf8')
    const payload     = Buffer.allocUnsafe(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)

    const frame = encodeFrame(payload, Opcode.CLOSE, false)
    this.socket.write(frame, () => {
      // Destroy the socket after the close frame is flushed
      this.socket.destroy()
      this.state = ConnectionState.CLOSED
      this.emit('close', code, reason)
    })
  }

  // ─── Data Handling ───────────────────────────────────────────────────────

  // TCP is a stream — a single 'data' event might contain:
  //   - an incomplete frame  → buffer and wait
  //   - exactly one frame    → decode and emit
  //   - multiple frames      → loop and drain
  private handleData(chunk: Buffer): void {
    // Append incoming bytes to our running buffer
    this.buffer = Buffer.concat([this.buffer, chunk])

    // Keep pulling frames out until the buffer is exhausted or incomplete
    while (this.buffer.length > 0) {
      const result = decodeFrame(this.buffer)

      // decodeFrame returns null when it needs more bytes
      if (result === null) break

      const [frame, bytesConsumed] = result

      // Slice off the bytes we just consumed
      this.buffer = this.buffer.subarray(bytesConsumed)

      this.handleFrame(frame)
    }
  }

  // Route a fully-decoded frame to the right handler
  private handleFrame(frame: HyperFrame): void {
    switch (frame.opcode) {

      case Opcode.TEXT: {
        const msg: HyperMessage = {
          type: 'text',
          data: frame.payload.toString('utf8'),
          from: this.id,
        }
        this.emit('message', msg)
        break
      }

      case Opcode.BINARY: {
        const msg: HyperMessage = {
          type: 'binary',
          data: frame.payload,
          from: this.id,
        }
        this.emit('message', msg)
        break
      }

      case Opcode.PING: {
        // RFC 6455 §5.5.3 — MUST reply with a Pong containing the same payload
        const pong = encodeFrame(frame.payload, Opcode.PONG, false)
        this.socket.write(pong)
        this.emit('ping')
        break
      }

      case Opcode.PONG: {
        // Client is alive — reset the watchdog
        this.isAlive = true
        if (this.pongTimer) {
          clearTimeout(this.pongTimer)
          this.pongTimer = undefined
        }
        this.emit('pong')
        break
      }

      case Opcode.CLOSE: {
        // Parse the status code and reason from the Close frame payload
        let code   = CloseCode.NO_STATUS
        let reason = ''
        if (frame.payload.length >= 2) {
          code   = frame.payload.readUInt16BE(0) as CloseCode
          reason = frame.payload.subarray(2).toString('utf8')
        }
        // Echo the Close frame back (required by RFC 6455 §5.5.1)
        const echo = encodeFrame(frame.payload, Opcode.CLOSE, false)
        this.socket.write(echo, () => this.socket.destroy())
        this.state = ConnectionState.CLOSED
        this.stopHeartbeat()
        this.emit('close', code, reason)
        break
      }

      case Opcode.CONTINUATION:
        // TODO: implement message fragmentation in a future version
        // For now we only handle single-frame (FIN=1) messages
        break
    }
  }

  private handleSocketEnd(): void {
    if (this.state !== ConnectionState.CLOSED) {
      this.state = ConnectionState.CLOSED
      this.stopHeartbeat()
      this.emit('close', CloseCode.ABNORMAL, 'socket ended')
    }
  }

  // ─── Heartbeat (Ping / Pong) ─────────────────────────────────────────────
  // Every heartbeatInterval ms we send a Ping.
  // If no Pong comes back within heartbeatTimeout ms, we drop the connection.
  // This catches zombie connections — clients that disappeared without a Close frame.

  private scheduleHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (!this.isAlive) {
        // Previous ping was never answered — connection is dead
        this.close(CloseCode.ABNORMAL, 'heartbeat timeout')
        return
      }

      // Mark as unresponsive until we get a pong back
      this.isAlive = false

      // Send ping with a small timestamp payload for debugging
      const payload = Buffer.from(Date.now().toString())
      const ping    = encodeFrame(payload, Opcode.PING, false)
      this.socket.write(ping)
      this.emit('ping')

      // If pong doesn't arrive in time, force-close
      this.pongTimer = setTimeout(() => {
        if (!this.isAlive) {
          this.close(CloseCode.ABNORMAL, 'pong timeout')
        }
      }, this.heartbeatTimeout)

    }, this.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer);  this.pingTimer = undefined }
    if (this.pongTimer) { clearTimeout(this.pongTimer);   this.pongTimer = undefined }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  // Returns a plain object snapshot — safe to JSON.stringify and log
  toInfo(): ConnectionInfo {
    return {
      id:       this.id,
      state:    this.state,
      joinedAt: this.joinedAt,
      rooms:    new Set(this.rooms),
      ip:       this.ip,
    }
  }

  getState(): ConnectionState { return this.state }

  private assertState(expected: ConnectionState, op: string): void {
    if (this.state !== expected) {
      throw new Error(
        `HyperConnection: cannot '${op}' in state '${this.state}' (expected '${expected}')`
      )
    }
  }
}