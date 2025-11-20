## Custom WebSocket Implementation (RFC 6455)

This project implements WebSockets **without using socket.io or `ws`**, built directly on Node's TCP sockets.

### Features Implemented
- Manual HTTP Upgrade handshake
- RFC 6455 key hashing using SHA1
- Frame decoding (masking, payload length, opcodes)
- Frame encoding for server-to-client messages
- Event-driven API (`on("message")`, `send()`)

### Tech Stack
- Node.js (raw TCP `net` module)
- TypeScript
- No external WebSocket libraries

### Example
```js
const ws = new WebSocket("ws://localhost:3348");
ws.send("Hello");
ws.onmessage = e => console.log(e.data);
