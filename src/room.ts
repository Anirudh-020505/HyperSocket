// src/room.ts
// A Room is a named group of connections.
// Clients join rooms by name. The server broadcasts to a room
// and every member gets the message — like socket.io rooms but ours.
// Rooms are created lazily (on first join) and destroyed when empty.

import { HyperConnection } from './connection'
import { CloseCode }        from './types'

export class HyperRoom {

  readonly name: string

  // Map of connectionId → HyperConnection
  // Using a Map (not an array) so join/leave/lookup are all O(1)
  private members: Map<string, HyperConnection> = new Map()

  constructor(name: string) {
    this.name = name
  }

  // Add a connection to this room
  join(conn: HyperConnection): void {
    if (this.members.has(conn.id)) return  // already in room, no-op
    this.members.set(conn.id, conn)
    conn.rooms.add(this.name)
  }

  // Remove a connection from this room
  leave(conn: HyperConnection): void {
    this.members.delete(conn.id)
    conn.rooms.delete(this.name)
  }

  // Send a text message to every member except the optional sender
  // The 'except' parameter lets you broadcast without echoing back to sender
  broadcast(data: string, except?: string): void {
    for (const [id, conn] of this.members) {
      if (id === except) continue
      try {
        conn.send(data)
      } catch {
        // Connection may have closed between the loop start and here
        // Safe to ignore — the server's 'close' handler will clean it up
      }
    }
  }

  // Send a binary message to every member except the optional sender
  broadcastBinary(data: Buffer, except?: string): void {
    for (const [id, conn] of this.members) {
      if (id === except) continue
      try {
        conn.send(data)
      } catch {
        // Same as above — swallow send errors on dead connections
      }
    }
  }

  // How many connections are currently in this room
  get size(): number {
    return this.members.size
  }

  // Is this room empty? HyperServer uses this to garbage-collect rooms
  get isEmpty(): boolean {
    return this.members.size === 0
  }

  // Returns all connection IDs in the room — useful for presence features
  getMemberIds(): string[] {
    return Array.from(this.members.keys())
  }
}