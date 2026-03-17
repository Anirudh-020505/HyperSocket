// src/server.ts
// HyperServer — the main class applications use.
// Creates a raw TCP server, handles HTTP upgrades, manages the
// connection pool and rooms, and exposes a clean event-driven API.

import * as net  from 'net'
import * as http from 'http'
import { EventEmitter }    from 'events'
import { HyperConnection } from './connection'
import { HyperRoom }       from './room'
import { parseHandshakeKey, buildHandshakeResponse, isUpgradeRequest } from './handshake'
import {
  HyperServerOptions,
  HyperMessage,
  ConnectionInfo,
  CloseCode,
} from './types'

// Defaults — can be overridden in HyperServerOptions
const DEFAULT_HEARTBEAT_INTERVAL = 30_000  // 30 seconds
const DEFAULT_HEARTBEAT_TIMEOUT  =  5_000  // 5 seconds
const DEFAULT_MAX_PAYLOAD        = 10 * 1024 * 1024  // 10 MB

export class HyperServer extends EventEmitter {

  private server:      http.Server
  private connections: Map<string, HyperConnection> = new Map()
  private rooms:       Map<string, HyperRoom>       = new Map()
  private opts:        Required<HyperServerOptions>

  constructor(opts: HyperServerOptions) {
    super()
    this.opts = {
      heartbeatInterval: opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      heartbeatTimeout:  opts.heartbeatTimeout  ?? DEFAULT_HEARTBEAT_TIMEOUT,
      maxPayloadSize:    opts.maxPayloadSize     ?? DEFAULT_MAX_PAYLOAD,
      port:              opts.port,
    }

    // We create an http.Server so we can listen for the 'upgrade' event.
    // All normal HTTP requests (non-upgrade) get a 426 response.
    this.server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' })
      res.end('426 Upgrade Required — this server only accepts WebSocket connections')
    })

    // The 'upgrade' event fires when a client sends:
    //   GET / HTTP/1.1
    //   Upgrade: websocket
    // This is the entry point for every WebSocket connection
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as net.Socket, head)
    })
  }

  // ─── Upgrade Handling ────────────────────────────────────────────────────

  private handleUpgrade(
    req:    http.IncomingMessage,
    socket: net.Socket,
    _head:  Buffer
  ): void {
    // Reconstruct the raw HTTP request string so our handshake parser can read it
    const rawRequest = `GET ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n\r\n'

    if (!isUpgradeRequest(rawRequest)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    const key = parseHandshakeKey(rawRequest)
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing Sec-WebSocket-Key')
      socket.destroy()
      return
    }

    // Send the 101 Switching Protocols response
    // After this line, the socket speaks WebSocket frames — not HTTP
    const response = buildHandshakeResponse(key)
    socket.write(response)

    // Create a connection object and track it
    const conn = new HyperConnection(socket, {
      heartbeatInterval: this.opts.heartbeatInterval,
      heartbeatTimeout:  this.opts.heartbeatTimeout,
    })

    this.connections.set(conn.id, conn)

    // Wire up connection-level events so HyperServer can re-emit them
    conn.on('message', (msg: HyperMessage) => {
      this.emit('message', conn.toInfo(), msg)
    })

    conn.on('close', (code: CloseCode, reason: string) => {
      this.handleConnectionClose(conn, code, reason)
    })

    conn.on('error', (err: Error) => {
      this.emit('error', conn.toInfo(), err)
    })

    conn.on('ping', () => this.emit('ping', conn.toInfo()))
    conn.on('pong', () => this.emit('pong', conn.toInfo()))

    // Transition the connection to OPEN — starts data flow and heartbeat
    conn.open()

    this.emit('connection', conn.toInfo())
  }

  // ─── Connection Management ───────────────────────────────────────────────

  private handleConnectionClose(
    conn:   HyperConnection,
    code:   CloseCode,
    reason: string
  ): void {
    // Remove from all rooms it was in
    for (const roomName of conn.rooms) {
      const room = this.rooms.get(roomName)
      if (room) {
        room.leave(conn)
        // Garbage-collect the room if it's now empty
        if (room.isEmpty) this.rooms.delete(roomName)
      }
    }

    // Remove from the connection pool
    this.connections.delete(conn.id)

    this.emit('close', conn.toInfo(), code, reason)
  }

  // ─── Room API ────────────────────────────────────────────────────────────

  // Join a connection to a named room, creating the room if it doesn't exist
  join(connId: string, roomName: string): void {
    const conn = this.connections.get(connId)
    if (!conn) throw new Error(`No connection with id '${connId}'`)

    if (!this.rooms.has(roomName)) {
      this.rooms.set(roomName, new HyperRoom(roomName))
    }

    this.rooms.get(roomName)!.join(conn)
  }

  // Remove a connection from a named room
  leave(connId: string, roomName: string): void {
    const conn = this.connections.get(connId)
    if (!conn) return

    const room = this.rooms.get(roomName)
    if (!room) return

    room.leave(conn)
    if (room.isEmpty) this.rooms.delete(roomName)
  }

  // ─── Broadcast API ───────────────────────────────────────────────────────

  // Send to every connection on the server
  broadcast(data: string, except?: string): void {
    for (const [id, conn] of this.connections) {
      if (id === except) continue
      try { conn.send(data) } catch { /* dead connection — ignore */ }
    }
  }

  // Send to every connection in a specific room
  broadcastToRoom(roomName: string, data: string, except?: string): void {
    const room = this.rooms.get(roomName)
    if (!room) return
    room.broadcast(data, except)
  }

  // Send to one specific connection by ID
  sendTo(connId: string, data: string): void {
    const conn = this.connections.get(connId)
    if (!conn) throw new Error(`No connection with id '${connId}'`)
    conn.send(data)
  }

  // ─── Server Lifecycle ────────────────────────────────────────────────────

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, () => {
        console.log(`HyperSocket listening on port ${this.opts.port}`)
        resolve()
      })
    })
  }

  // Gracefully shut down — close all connections then stop the server
  async close(): Promise<void> {
    // Send Close frames to all connected clients
    for (const conn of this.connections.values()) {
      conn.close(CloseCode.GOING_AWAY, 'server shutting down')
    }

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // ─── Introspection ───────────────────────────────────────────────────────

  getConnection(id: string): ConnectionInfo | undefined {
    return this.connections.get(id)?.toInfo()
  }

  getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values()).map(c => c.toInfo())
  }

  getRoomMembers(roomName: string): string[] {
    return this.rooms.get(roomName)?.getMemberIds() ?? []
  }

  get connectionCount(): number {
    return this.connections.size
  }
}