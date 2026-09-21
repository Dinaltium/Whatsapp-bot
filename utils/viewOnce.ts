/**
 * View-once detection that matches what WhatsApp actually sends today.
 *
 * Shapes seen in the wild:
 *   - wrapped:  viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
 *               (Extension is used for video + voice notes)
 *   - flat:     imageMessage / videoMessage / audioMessage with `viewOnce: true`
 *   - either of the above nested inside ephemeralMessage (disappearing chats)
 *
 * Baileys' normalizeMessageContent() unwraps every wrapper (ephemeral,
 * view-once variants, documentWithCaption, edited) — same approach OpenWA
 * takes — so we only need to inspect the inner media afterwards.
 *
 * NOTE: WhatsApp does not deliver view-once media to linked WEB devices at
 * all (it sends a placeholder). The socket must identify as an Android
 * companion (WA_BROWSER=android, Baileys >= rc14) for any of this to fire.
 */
import { normalizeMessageContent, type proto } from "@whiskeysockets/baileys";

export type ViewOnceKind = "image" | "video" | "audio" | "document";

export interface ViewOnceMedia {
  kind: ViewOnceKind;
  media: any;
  /** The normalized inner message (wrappers removed) — pass to downloadMediaMessage via a WebMessageInfo. */
  inner: proto.IMessage;
}

function hasWrapper(m: proto.IMessage | null | undefined): boolean {
  if (!m) return false;
  const eph = (m as any).ephemeralMessage?.message as proto.IMessage | undefined;
  const root = eph || m;
  return !!(root.viewOnceMessage || root.viewOnceMessageV2 || (root as any).viewOnceMessageV2Extension);
}

/** Returns the inner media of a view-once message, or null if this isn't one. */
export function getViewOnceMedia(message: proto.IMessage | null | undefined): ViewOnceMedia | null {
  if (!message) return null;
  const inner = normalizeMessageContent(message);
  if (!inner) return null;

  const wrapped = hasWrapper(message);
  const candidates: [ViewOnceKind, any][] = [
    ["image", inner.imageMessage],
    ["video", inner.videoMessage],
    ["audio", inner.audioMessage],
    ["document", inner.documentMessage],
  ];
  for (const [kind, media] of candidates) {
    if (!media) continue;
    if (wrapped || media.viewOnce === true) return { kind, media, inner };
  }
  return null;
}

/** Any downloadable media (view-once or not) after unwrapping. Used by !reveal's quoted-copy fallback. */
export function getAnyMedia(message: proto.IMessage | null | undefined): ViewOnceMedia | null {
  if (!message) return null;
  const inner = normalizeMessageContent(message);
  if (!inner) return null;
  const candidates: [ViewOnceKind, any][] = [
    ["image", inner.imageMessage],
    ["video", inner.videoMessage],
    ["audio", inner.audioMessage],
    ["document", inner.documentMessage],
  ];
  for (const [kind, media] of candidates) if (media) return { kind, media, inner };
  return null;
}

/** True when the media carries a usable key (quoted view-once copies have it stripped). */
export function hasMediaKey(media: any): boolean {
  const k = media?.mediaKey;
  if (!k) return false;
  if (typeof k === "string") return k.length > 0;
  if (typeof k.length === "number") return k.length > 0;
  return Object.keys(k).length > 0;
}
