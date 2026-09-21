/**
 * Round-trip a Baileys WebMessageInfo through Redis/JSON without losing
 * binary fields.
 *
 * Plain JSON.stringify turns `mediaKey: Uint8Array` into `{"0":12,"1":200,…}`,
 * which is truthy but not a key — downloadMediaMessage then fails with
 * "Cannot derive from empty media key" or a bad HKDF. Encoding via the
 * protobuf helpers keeps bytes as base64 and restores them on the way back.
 */
import { proto } from "@whiskeysockets/baileys";

export function serializeWAMessage(msg: proto.IWebMessageInfo): string {
  const obj = proto.WebMessageInfo.toObject(msg as proto.WebMessageInfo, {
    bytes: String, // Uint8Array -> base64
    longs: String, // Long -> string (avoids precision loss)
    defaults: false,
  });
  return JSON.stringify(obj);
}

export function deserializeWAMessage(json: string): proto.IWebMessageInfo {
  return proto.WebMessageInfo.fromObject(JSON.parse(json));
}
