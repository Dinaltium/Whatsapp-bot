/**
 * Contact Sync Handlers
 * 
 * Extracts and maps contacts from Baileys events.
 */

import { normalizeJid } from "../../security/rbac";
import { logEvent } from "../../utils/logger";

export function registerContactSyncHandlers(sock: any): void {
  sock.ev.on("contacts.upsert", async (contacts: any) => {
    try {
      const { storeLidPhoneMapping } = await import("../../storage/core/rbacRepository");
      const { redis } = await import("../../storage/redisClient");
      let stored = 0;
      let namesStored = 0;
      for (const contact of contacts) {
        if (!contact) continue;

        const cid = contact.id ? normalizeJid(contact.id) : null;
        const clid = (contact as any).lid ? normalizeJid((contact as any).lid) : null;
        const cpn = (contact as any).phoneNumber ? normalizeJid((contact as any).phoneNumber) : null;

        const name = contact.name || contact.verifiedName || contact.notify;

        if (name) {
          if (cid) {
            await redis.hset("contact_names", cid, name);
            namesStored++;
          }
          if (clid && clid !== cid) {
            await redis.hset("contact_names", clid, name);
            namesStored++;
          }
          if (cpn && cpn !== cid && cpn !== clid) {
            await redis.hset("contact_names", cpn, name);
            namesStored++;
          }
        }

        // contact.name is the address-book name YOU assigned → a saved contact.
        // (verifiedName/notify are their own profile name, not "saved".)
        if (contact.name) {
          const { markSavedContact } = await import("../../agents/Generic/autoResponder");
          await markSavedContact([cid, clid, cpn]);
        }

        let resolvedLid: string | null = null;
        let resolvedPn: string | null = null;

        // Case A: id is phone JID, lid is LID
        if (cid && cid.endsWith("@s.whatsapp.net")) {
          resolvedPn = cid;
          if (clid && clid.endsWith("@lid")) resolvedLid = clid;
        }
        // Case B: id is LID, phoneNumber is phone JID
        else if (cid && cid.endsWith("@lid")) {
          resolvedLid = cid;
          if (cpn && cpn.endsWith("@s.whatsapp.net")) {
            resolvedPn = cpn;
          } else if ((contact as any).phone) {
            const digits = String((contact as any).phone).replace(/\D/g, "");
            if (digits) resolvedPn = `${digits}@s.whatsapp.net`;
          }
        }

        if (resolvedLid && resolvedPn) {
          await storeLidPhoneMapping(resolvedLid, resolvedPn);
          stored++;
        }
      }
      if (stored > 0 || namesStored > 0) {
        logEvent("debug", { event: "contacts_upserted", lidMapped: stored, namesCached: namesStored });
      }
    } catch (_e) { /* non-critical */ }
  });

  sock.ev.on("contacts.update", async (contacts: any) => {
    try {
      const { redis } = await import("../../storage/redisClient");
      const { storeLidPhoneMapping } = await import("../../storage/core/rbacRepository");
      let namesStored = 0;
      for (const contact of contacts) {
        if (!contact) continue;

        const cid = contact.id ? normalizeJid(contact.id) : null;
        const clid = (contact as any).lid ? normalizeJid((contact as any).lid) : null;
        const cpn = (contact as any).phoneNumber ? normalizeJid((contact as any).phoneNumber) : null;

        const name = contact.name || contact.verifiedName || contact.notify;

        if (name) {
          if (cid) {
            await redis.hset("contact_names", cid, name);
            namesStored++;
          }
          if (clid && clid !== cid) {
            await redis.hset("contact_names", clid, name);
            namesStored++;
          }
          if (cpn && cpn !== cid && cpn !== clid) {
            await redis.hset("contact_names", cpn, name);
            namesStored++;
          }
        }

        if (contact.name) {
          const { markSavedContact } = await import("../../agents/Generic/autoResponder");
          await markSavedContact([cid, clid, cpn]);
        }

        if (clid && cpn) {
          await storeLidPhoneMapping(clid, cpn);
        }
      }
      if (namesStored > 0) {
        logEvent("debug", { event: "contacts_updated", namesCached: namesStored });
      }
    } catch (_e) { /* non-critical */ }
  });
}
