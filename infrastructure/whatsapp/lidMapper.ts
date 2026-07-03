/**
 * LID Mapping Handlers
 * 
 * Extracts and maps LIDs to phone numbers from group participant updates and lid-mapping events.
 */

import { normalizeJid } from "../../security/rbac";
import { logStructured, getJidHash } from "../../utils/logger";
import groupConfig from "../../config/groupAllowlist";

export function registerLidMapperHandlers(sock: any): void {
  // ── LID MAPPING VIA GROUP PARTICIPANT EVENTS ──────────────────────────────
  sock.ev.on("group-participants.update", async (update: any) => {
    try {
      const { storeLidPhoneMapping } = await import("../../storage/core/rbacRepository");
      const groupBot = groupConfig.getGroupBot(update.id);
      const isBot2 = groupBot?.botNumber === 2;

      for (const participant of update.participants || []) {
        if (!participant) continue;
        const pid = typeof participant === "string" ? normalizeJid(participant) : (participant.id ? normalizeJid(participant.id) : null);
        const plid = (participant as any).lid ? normalizeJid((participant as any).lid) : null;
        const ppn = (participant as any).phoneNumber ? normalizeJid((participant as any).phoneNumber) : null;

        let resolvedLid: string | null = null;
        let resolvedPn: string | null = null;

        if (pid && pid.endsWith("@s.whatsapp.net")) {
          resolvedPn = pid;
          if (plid && plid.endsWith("@lid")) resolvedLid = plid;
        } else if (pid && pid.endsWith("@lid")) {
          resolvedLid = pid;
          if (ppn && ppn.endsWith("@s.whatsapp.net")) {
            resolvedPn = ppn;
          } else if ((participant as any).phone) {
            const digits = String((participant as any).phone).replace(/\D/g, "");
            if (digits) resolvedPn = `${digits}@s.whatsapp.net`;
          }
        }

        if (resolvedLid && resolvedPn) {
          await storeLidPhoneMapping(resolvedLid, resolvedPn);
        }

        // On a new member joining a Bot 2 (DKB) group, notify the mentor group
        // so a human can add them via !addmentor if they're a mentor. No LLM
        // classification (see introNotifier).
        if (isBot2 && update.action === "add") {
          const targetJid = resolvedPn || pid;
          if (targetJid && !targetJid.endsWith("@g.us")) {
            const { notifyMentorGroupOfNewMember } = await import(
              "./introNotifier"
            );
            await notifyMentorGroupOfNewMember(sock, update.id, targetJid);
          }
        }
      }
    } catch (_e) { /* non-critical */ }
  });

  // ── LID MAPPING VIA NATIVE 6.8.0 EVENT ──────────────────────────────
  sock.ev.on("lid-mapping.update" as any, async (update: any) => {
    try {
      const { storeLidPhoneMapping } = await import("../../storage/core/rbacRepository");
      const items = Array.isArray(update) ? update : [update];
      let count = 0;
      for (const item of items) {
        if (!item) continue;
        const rawLid = item.lid;
        const rawPn = item.pn || item.phoneNumber || item.jid || item.id;
        if (rawLid && rawPn && typeof rawLid === "string" && typeof rawPn === "string") {
          const normalizedLid = normalizeJid(rawLid);
          const normalizedPn = normalizeJid(rawPn);
          if (normalizedLid && normalizedPn && normalizedLid.endsWith("@lid") && normalizedPn.endsWith("@s.whatsapp.net")) {
            await storeLidPhoneMapping(normalizedLid, normalizedPn);
            count++;
          }
        }
      }
      if (count > 0) {
        logStructured({ event: "lid_mapped_from_event", count });
      }
    } catch (_e) { /* non-critical */ }
  });
}
