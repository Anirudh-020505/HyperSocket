import { Socket } from "net";
import decodeFrame from "./utils/frame";
import { encodeFrame } from "./utils/encode";
import { EventEmitter } from "./utils/event";

export class WebSocketConnection extends EventEmitter {
  private socket: Socket;

  constructor(socket: Socket) {
    super(); // initialize EventEmitter
    this.socket = socket;

    this.socket.on("data", (chunk: Buffer) => {
      const message = decodeFrame(chunk);
      this.emit("message", message);
    });

    this.socket.on("end", () => this.emit("close"));
    this.socket.on("error", (err) => this.emit("error", err));
  }

  send(message: string) {
    this.socket.write(encodeFrame(message));
  }

  close() {
    this.socket.end();
  }
}
