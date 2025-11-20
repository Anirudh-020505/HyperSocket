// We will have all decoding logic here 

export default function decodeFrame(buffer: Buffer): string{

    // first read byte 1 ( It has fin + opcode)

    const  firstByte = buffer[0]
    const opcode = firstByte & 0x0f; 
// opcode =1 text frames
    if (opcode !== 0x1){
    console.log("Unsupported opcode:", opcode);
    return "";
        
    }
    // byte 2 ko read karo 
    const secondByte = buffer[1]
    //check maskbit
    const isMasked = (secondByte & 0x80) === 0x80 
    if (!isMasked){
        console.log("Frame is not masked — invalid from browser")
        return ""
    }

    let payLoadLength = secondByte & 0x7f ; //lower 7 bits 

    let offset = 2; 

    if (payLoadLength === 126){
        payLoadLength = buffer.readUInt16BE(offset); 
        offset += 2 

    }else if (payLoadLength === 127){
        payLoadLength = Number(buffer.readBigUInt64BE(offset))
        offset += 8 
    }

    // Read actual key (4 byte)
    const maskingKey = buffer.slice(offset, offset+4)
    offset += 4 
    const maskedPayload = buffer.slice(offset, offset + payLoadLength);
    const unmaskedPayload = Buffer.alloc(payLoadLength)

    for(let i = 0 ; i < payLoadLength; i++){
        unmaskedPayload[i] = maskedPayload[i] ^ maskingKey[i%4]; 
    }

    return unmaskedPayload.toString("utf-8")
}