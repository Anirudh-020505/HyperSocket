import http, { IncomingMessage, Server, ServerResponse } from "http";
import decodeFrame from "./utils/frame";
import { encodeFrame } from "./utils/encode";
import {Socket} from "net"; 

import crypto from "crypto"; 



// GUID STRING -- RFC PROTOCAL 
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";


// WEBSOCKET KEY MILEGA CLIENT SE 
// usko hash karke bhejo
function generateAcceptValue(webSocketKey: string):string{
    return crypto.createHash("sha1").update(webSocketKey + WEBSOCKET_GUID).digest("base64")

}
// start server 
function startServer(port : number){
    const server =http.createServer((req :IncomingMessage ,res:http.ServerResponse)=>{
        res.writeHead(404); 
        res.end("This Only supports websocket connection")
        
    })
    // when upgrade event is sent - handshake 
    server.on("upgrade", (req:IncomingMessage, socket:Socket , head:Buffer) =>{ 
        console.log("Recieved websocket upgrade request")

        const upgradeHeader = req.headers["upgrade"]
        const connectionHeader = req.headers["connection"]
        if (!upgradeHeader || upgradeHeader.toLowerCase() !=='websocket'){
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
            socket.destroy()
            return
        }
        if(!connectionHeader || !connectionHeader.toLowerCase().includes("upgrade")){
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
            socket.destroy()
            return 
        }
        const secWebSocketKey = req.headers['sec-websocket-key']

        if (typeof secWebSocketKey !== "string" ){
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;

        }
        const acceptValue = generateAcceptValue(secWebSocketKey); 
        const responseHeader = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptValue}`,

        ]
        socket.write(responseHeader.join("\r\n") + "\r\n\r\n"); 

        console.log("websocket handshake is completed ")
        // This chunk = the raw WebSocket frame - 
        socket.on("data", (chunk: Buffer) => {
            const message = decodeFrame(chunk)
            // console.log("Recieved raw data", chunk);
            console.log('client says', message) 

            socket.write(encodeFrame("Server got: " + message));

        })
        socket.on("end" , ()=> console.log("❌ client bhag gya - Disconnected"))

        socket.on("error", (err) => console.log("⚠ Socket error:", err.message));

    })
    server.listen(port, ()=>{
        console.log(`server started on ws://localhost:${port}`)
    })

}
startServer(3348); 


//websocket uses tcp under the hood 
// tcp sends ata in package 
// buffer - banry data conatiner in node js - < Buffer  48 65 6c 6c 6f> - means hello 

// websocketFrames includes It includes:

// opcodes

// masking

// payload lengths

// masked payload data

// ping and pong kya hai - byte 2 has Mask bit and Payload length - (7 bits )

// masking key - XOR -excrypt data 