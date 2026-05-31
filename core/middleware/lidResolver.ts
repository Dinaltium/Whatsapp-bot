/**
 * LID Resolver Middleware
 *
 * Resolves WhatsApp LID (Linked Identity) sender IDs to canonical phone JIDs.
 * Uses a multi-strategy cascade:
 *   0. Baileys 6.8.0 alternate JID extraction (zero-query)
 *   1. Database mapping table (populated by !manage)
 *   2. Baileys signalRepository.lidMapping
 *   3. Group metadata participant scan
 *
 * Extracted from messageRouter.ts to reduce routing complexity.
 */

import { normalizeJid, getSenderId } from "../../security/rbac";
import { getJidHash, logStructured } from "../../utils/logger";

/**
 * Resolves a sender identity, extracting alternate JID mappings and
 * falling back through multiple LID resolution strategies.
 *
 * @param msg - The raw Baileys message
 * @param sock - The Baileys socket instance
 * @param from - The chat JID where the message was received
 * @param initialSenderId - The initially extracted sender ID
 * @returns The resolved sender ID (phone JID if possible, otherwise original LID)
 */
export async function resolveSenderId(
  msg: any,
  sock: any,
  from: string,
  initialSenderId: string,
): Promise<string> {
  let senderId = initialSenderId;

  if (msg.key?.fromMe && sock.user?.id) {
    return normalizeJid(sock.user.id) as string;
  }

  // ── ZERO-QUERY INSTANT ALTERNATE JID EXTRACTION (Baileys 6.8.0) ──
  const rawParticipant = msg.key?.participant;
  const altParticipant = (msg.key as any)?.participantAlt;
  const rawRemoteJid = msg.key?.remoteJid;
  const altRemoteJid = (msg.key as any)?.remoteJidAlt;

  let hasAltMapping = false;

  if (rawParticipant && altParticipant && typeof rawParticipant === "string" && typeof altParticipant === "string") {
    const normalizedLid = normalizeJid(rawParticipant);
    const normalizedPn = normalizeJid(altParticipant);
    if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
      senderId = normalizedPn;
      hasAltMapping = true;
      import("../../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
        storeLidPhoneMapping(normalizedLid, normalizedPn)
      ).catch(() => {});
    }
  }

  if (!hasAltMapping && rawRemoteJid && altRemoteJid && typeof rawRemoteJid === "string" && typeof altRemoteJid === "string") {
    const normalizedLid = normalizeJid(rawRemoteJid);
    const normalizedPn = normalizeJid(altRemoteJid);
    if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
      hasAltMapping = true;
      import("../../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
        storeLidPhoneMapping(normalizedLid, normalizedPn)
      ).catch(() => {});
    }
  }

  // ── LID → PHONE JID RESOLUTION CASCADE ──
  if (senderId && senderId.endsWith("@lid")) {
    const rawLid = senderId;
    let lidResolved = false;

    // Strategy 0: DB mapping table (most reliable — populated by !manage)
    try {
      const { resolvePhoneJidFromLid } = await import("../../storage/core/rbacRepository");
      const dbResolved = await resolvePhoneJidFromLid(rawLid);
      if (dbResolved) {
        logStructured({ event: "lid_resolved_via_db", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(dbResolved) });
        senderId = dbResolved;
        lidResolved = true;
      }
    } catch (_e) { /* db unavailable — fall through */ }

    // Strategy 1: Baileys native signalRepository.lidMapping
    if (!lidResolved) {
      try {
        const lidNum = rawLid.split("@")[0];
        const pn = (sock as any).signalRepository?.lidMapping?.getPNForLID?.(lidNum);
        if (pn && typeof pn === "string") {
          const resolvedId = normalizeJid(`${pn}@s.whatsapp.net`);
          if (resolvedId && !resolvedId.endsWith("@lid")) {
            logStructured({ event: "lid_resolved_via_signal", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(resolvedId) });
            senderId = resolvedId;
            lidResolved = true;
            import("../../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
              storeLidPhoneMapping(rawLid, resolvedId)
            ).catch(() => {});
          }
        }
      } catch (_e) { /* signalRepository not available — fall through */ }
    }

    // Strategy 2: Group metadata participant scan (Upgraded for Baileys 6.8.0 Contact changes)
    if (!lidResolved && from.endsWith("@g.us")) {
      try {
        const metadata = await sock.groupMetadata(from);
        if (metadata && metadata.participants) {
          const participant = metadata.participants.find((p: any) => {
            const pid = p.id ? (normalizeJid(p.id) ?? "").toLowerCase() : "";
            const plid = p.lid ? (normalizeJid(p.lid) ?? "").toLowerCase() : "";
            const targetLower = rawLid.toLowerCase();
            return pid === targetLower || plid === targetLower;
          });

          if (participant) {
            const pid = participant.id ? normalizeJid(participant.id) : null;
            const ppn = participant.phoneNumber ? normalizeJid(participant.phoneNumber) : null;

            let resolvedId: string | null = null;
            if (pid && pid.endsWith("@s.whatsapp.net")) {
              resolvedId = pid;
            } else if (ppn && ppn.endsWith("@s.whatsapp.net")) {
              resolvedId = ppn;
            } else if ((participant as any).phone) {
              const phoneStr = String((participant as any).phone);
              const digits = phoneStr.replace(/\D/g, "");
              if (digits) resolvedId = `${digits}@s.whatsapp.net`;
            }

            if (resolvedId && !resolvedId.endsWith("@lid")) {
              logStructured({ event: "lid_resolved_via_metadata", rawLidHash: getJidHash(rawLid), resolvedHash: getJidHash(resolvedId) });
              senderId = resolvedId;
              lidResolved = true;
              import("../../storage/core/rbacRepository").then(({ storeLidPhoneMapping }) =>
                storeLidPhoneMapping(rawLid, resolvedId)
              ).catch(() => {});
            }
          }

          if (!lidResolved) {
            logStructured({
              event: "lid_resolution_failed",
              rawLid,
              rawLidHash: getJidHash(rawLid),
              groupHash: getJidHash(from),
              participantCount: metadata.participants.length,
              sampleLids: metadata.participants.slice(0, 5).map((p: any) => ({
                id: p.id ?? null,
                lid: p.lid ?? null,
                phoneNumber: p.phoneNumber ?? null,
              })),
            });
          }
        }
      } catch (err) {
        console.warn("Failed to resolve LID from group metadata:", err);
      }
    }

    if (!lidResolved) {
      logStructured({ event: "lid_unresolved", rawLid, groupHash: getJidHash(from) });
    }
  }

  return senderId;
}
