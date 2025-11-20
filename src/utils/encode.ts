export function encodeFrame(message: string): Buffer {

//buffer low level container for binary data 
// create a buffer data 
  const payload = Buffer.from(message, "utf8");

  const payloadLength = payload.length;

  let frame: number[] = [];

  // for finbit and opcode
  frame.push(0x81); 

// browser doesnt need any masking , server needs to prtect against tcp attacks so mask bit = 0 
  if (payloadLength <= 125) {
    frame.push(payloadLength); // small payload
  } else if (payloadLength < 65536) {
    frame.push(126);
    frame.push((payloadLength >> 8) & 0xff);
    frame.push(payloadLength & 0xff);
  } else {
    frame.push(127);
    for (let i = 7; i >= 0; i--) {
      frame.push((payloadLength >> (8 * i)) & 0xff);
    }
  }

  // combiner header and payload 
  return Buffer.concat([Buffer.from(frame), payload]);
}
