// src/handshake.ts
// RFC 6455 HTTP→WebSocket upgrade handshake.
// The client sends an HTTP GET with Upgrade: websocket.
// We respond with a 101 Switching Protocols containing
// a SHA1 hash of the client's key + the magic GUID.
// After this, the TCP socket speaks WebSocket frames only.

import * as crypto from 'crypto'

// This magic string is defined in RFC 6455 §1.3.
// It is NOT a secret — every WebSocket implementation uses it.
// Its purpose is to prove the server knows the WebSocket protocol,
// so a plain HTTP server can't accidentally accept a WS upgrade.
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Given the raw HTTP upgrade request as a string,
 * parse out the Sec-WebSocket-Key header value.
 */
export function parseHandshakeKey(httpRequest: string): string | null {
  // HTTP headers are line-separated. We look for the key header (case-insensitive).
  const match = httpRequest.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)
  return match ? match[1].trim() : null
}

/**
 * Compute the Sec-WebSocket-Accept value.
 * Formula: base64(SHA1(clientKey + WS_MAGIC))
 * This is what the RFC mandates — if you get this wrong the browser rejects the handshake.
 */
export function computeAcceptKey(clientKey: string): string {
  return crypto
    .createHash('sha1')
    .update(clientKey + WS_MAGIC)
    .digest('base64')
}

/**
 * Build the complete HTTP 101 response to send back to the client.
 * After the client receives this, both sides switch to frame mode.
 */
export function buildHandshakeResponse(clientKey: string): string {
  const acceptKey = computeAcceptKey(clientKey)
  // The blank line at the end (\r\n\r\n) is mandatory —
  // it signals the end of HTTP headers
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',   // <-- this becomes the final \r\n\r\n
    '',
  ].join('\r\n')
}

/**
 * Returns true if the raw HTTP request looks like a valid WS upgrade.
 * Used by the server before attempting the handshake.
 */
export function isUpgradeRequest(httpRequest: string): boolean {
  return (
    httpRequest.includes('Upgrade: websocket') ||
    httpRequest.includes('Upgrade: WebSocket')
  )
}
