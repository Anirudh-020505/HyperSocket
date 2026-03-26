// src/codec.ts
// RFC 6455 WebSocket frame encoder and decoder.
// Pure functions — no I/O, no state, no side effects.
// Every other file in this package depends on this one.

export type Opcode =
  | 0x0  // continuation
  | 0x1  // text
  | 0x2  // binary
  | 0x8  // close
  | 0x9  // ping
  | 0xa  // pong

export interface DecodedFrame {
  fin: boolean
  opcode: Opcode
  masked: boolean
  payload: Buffer
}

/**
 * Decode a raw TCP buffer into a WebSocket frame.
 * Returns null if the buffer is incomplete (need more bytes).
 * Returns [frame, bytesConsumed] so the caller can slice the remainder.
 */
export function decodeFrame(buf: Buffer): [DecodedFrame, number] | null {
  // Need at least 2 bytes to read the header
  if (buf.length < 2) return null

  const byte0 = buf[0]
  const byte1 = buf[1]

  const fin    = (byte0 & 0x80) !== 0   // top bit of byte 0
  const opcode = (byte0 & 0x0f) as Opcode  // bottom 4 bits of byte 0
  const masked = (byte1 & 0x80) !== 0   // top bit of byte 1
  
  // Bottom 7 bits of byte 1 is the initial payload length field
  let payloadLen = byte1 & 0x7f
  let offset = 2  // we've read 2 bytes so far

  // If payloadLen is 126, the real length is in the next 2 bytes (uint16)
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null
    payloadLen = buf.readUInt16BE(offset)
    offset += 2
  }
  // If payloadLen is 127, the real length is in the next 8 bytes (uint64)
  // JS can't safely handle >2^53 so we read it as two 32-bit halves
  else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null
    // For our use case (chat app), files won't exceed 2^32 bytes
    // so we only read the low 32 bits and assert the high 32 bits are 0
    const high = buf.readUInt32BE(offset)
    const low  = buf.readUInt32BE(offset + 4)
    if (high !== 0) throw new Error('Frame too large (>4GB not supported)')
    payloadLen = low
    offset += 8
  }

  // If masked, read the 4-byte masking key
  let maskingKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskingKey = buf.subarray(offset, offset + 4)
    offset += 4
  }

  // Check we have the full payload
  if (buf.length < offset + payloadLen) return null

  // Extract the raw payload bytes
  const rawPayload = buf.subarray(offset, offset + payloadLen)
  offset += payloadLen

  // Unmask the payload: each byte XORed with maskingKey[i % 4]
  // This is why masking exists — XOR with a random key prevents
  // proxy cache poisoning (a proxy can't mistake this for HTTP)
  let payload: Buffer
  if (masked && maskingKey) {
    payload = Buffer.allocUnsafe(payloadLen)
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = rawPayload[i] ^ maskingKey[i % 4]
    }
  } else {
    // Server→client frames are never masked, copy as-is
    payload = Buffer.from(rawPayload)
  }

  return [{ fin, opcode, masked, payload }, offset]
}

/**
 * Encode a payload into a WebSocket frame buffer.
 * Server→client: never masked (mask = false).
 * Client→server: must be masked (mask = true).
 */
export function encodeFrame(
  payload: Buffer,
  opcode: Opcode = 0x1,
  mask: boolean = false
): Buffer {
  const payloadLen = payload.length

  // Calculate how many bytes we need for the length field
  // <126 bytes   → 1 byte (fits in the 7-bit field directly)
  // 126–65535    → 1 byte (value=126) + 2 bytes for real length
  // 65536+       → 1 byte (value=127) + 8 bytes for real length
  let headerLen = 2
  if (payloadLen >= 126 && payloadLen <= 0xffff) headerLen += 2
  else if (payloadLen > 0xffff) headerLen += 8
  if (mask) headerLen += 4  // masking key bytes

  const frame = Buffer.allocUnsafe(headerLen + payloadLen)

  // Byte 0: FIN=1 (always, we don't fragment) + opcode
  frame[0] = 0x80 | opcode

  // Byte 1: MASK bit + length
  if (payloadLen < 126) {
    frame[1] = (mask ? 0x80 : 0) | payloadLen
  } else if (payloadLen <= 0xffff) {
    frame[1] = (mask ? 0x80 : 0) | 126
    frame.writeUInt16BE(payloadLen, 2)
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127
    frame.writeUInt32BE(0, 2)           // high 32 bits = 0
    frame.writeUInt32BE(payloadLen, 6)  // low 32 bits
  }

  let offset = headerLen - (mask ? 4 : 0) - (mask ? 0 : 0)
  // Recalculate cleanly:
  offset = 2
  if (payloadLen >= 126 && payloadLen <= 0xffff) offset = 4
  else if (payloadLen > 0xffff) offset = 10

  if (mask) {
    // Generate a random 4-byte masking key
    const maskKey = Buffer.allocUnsafe(4)
    maskKey[0] = (Math.random() * 256) | 0
    maskKey[1] = (Math.random() * 256) | 0
    maskKey[2] = (Math.random() * 256) | 0
    maskKey[3] = (Math.random() * 256) | 0
    maskKey.copy(frame, offset)
    offset += 4

    // XOR each payload byte with the masking key
    for (let i = 0; i < payloadLen; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i % 4]
    }
  } else {
    // No masking — server→client path, just copy the payload
    payload.copy(frame, offset)
  }

  return frame
}