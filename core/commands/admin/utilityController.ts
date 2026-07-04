import { registerCommand } from "../commandRegistry";
import { sendBotReply } from "../../../bot";
import { isAdminAction } from "../../../security/rbac";
import { normalizeJid } from "../../../security/rbac";
import { redis } from "../../../storage/redisClient";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import groupConfig from "../../../config/groupAllowlist";
import {
  getSetting,
  setSetting,
  deleteSetting,
} from "../../../storage/core/settingsRepository";
import { INTRO_NOTIFY_SETTING_KEY } from "../../../infrastructure/whatsapp/introNotifier";

// ── UTILITY: UNWRAP EPHEMERAL MESSAGES ──
function unwrapMessage(message: any): any {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  return message;
}

// ── NEON PING ──
registerCommand({
  name: "neonping",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const { getDatabaseUrl } = await import("../../../storage/neonAuthStateStore");
      const dbUrl = getDatabaseUrl();
      if (!dbUrl) {
        await sendBotReply(ctx.sock, ctx.from, "Neon is NOT configured (DATABASE_URL is missing in environment variables).");
        return;
      }

      const { Pool } = await import("pg");
      const tempPool = new Pool({
        connectionString: dbUrl,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: false },
      });
      const start = Date.now();
      await tempPool.query("SELECT 1;");
      const duration = Date.now() - start;
      await tempPool.end();

      await sendBotReply(ctx.sock, ctx.from, `✅ Neon database is currently reachable! Timestamp: ${duration}ms.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendBotReply(ctx.sock, ctx.from, `❌ Neon database query failed:\n${msg}`);
    }
  }
});

// ── NEON RECONNECT ──
registerCommand({
  name: "neonconnect",
  requiresAdmin: true,
  handler: async (ctx) => {
    await sendBotReply(
      ctx.sock,
      ctx.from,
      "⏳ Initiating hard reconnect. The bot will exit and allow the environment manager (e.g. Render) to restart it cleanly with Neon connection..."
    );
    setTimeout(() => {
      process.exit(1);
    }, 2000);
  }
});

// ── REVEAL VIEW-ONCE MEDIA ──
registerCommand({
  name: "reveal",
  handler: async (ctx) => {
    const isRevealAuthorized = isAdminAction(ctx.msg, ctx.senderId);
    if (!isRevealAuthorized) {
      await sendBotReply(ctx.sock, ctx.from, "Unauthorized: admin privileges required for this command.");
      return;
    }

    const contextInfo = ctx.msg.message?.extendedTextMessage?.contextInfo;
    let targetMsg: any = null;
    let sourceLabel = "";

    if (contextInfo && contextInfo.quotedMessage) {
      targetMsg = {
        key: {
          remoteJid: ctx.from,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        },
        message: contextInfo.quotedMessage
      };
      sourceLabel = "quoted message";
    } else {
      const cachedJson = await redis.get(`latest_view_once:${ctx.from}`);
      if (cachedJson) {
        try {
          targetMsg = JSON.parse(cachedJson);
          sourceLabel = "latest cached view-once message";
        } catch (e) {
          console.error("Failed to parse cached view-once message:", e);
        }
      }
    }

    if (!targetMsg || !targetMsg.message) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Error: No quoted message provided, and no recent view-once media was found in this chat."
      );
      return;
    }

    const unwrapped = unwrapMessage(targetMsg.message);
    if (!unwrapped) {
      await sendBotReply(ctx.sock, ctx.from, "Error: Decrypted message has invalid structure.");
      return;
    }

    const viewOnceContainer = unwrapped.viewOnceMessage 
      || unwrapped.viewOnceMessageV2 
      || unwrapped.viewOnceMessageV2Lid;

    let mediaMsg = unwrapped;
    let isViewOnce = false;
    if (viewOnceContainer && viewOnceContainer.message) {
      mediaMsg = viewOnceContainer.message;
      isViewOnce = true;
    }

    const imageInfo = mediaMsg.imageMessage;
    const videoInfo = mediaMsg.videoMessage;
    const audioInfo = mediaMsg.audioMessage;
    const docInfo = mediaMsg.documentMessage;

    if (!imageInfo && !videoInfo && !audioInfo && !docInfo) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `Error: The ${sourceLabel} does not contain decryptable media (image, video, audio, or document).`
      );
      return;
    }

    const mode = ctx.majesticMode || "private";
    const destinationJid = mode === "private" ? (ctx.senderId || ctx.from) : ctx.from;

    try {
      const buffer = await downloadMediaMessage(
        targetMsg,
        "buffer",
        {}
      ) as Buffer;

      let caption: string | undefined = undefined;
      if (mode === "public_shazam") {
        caption = "SHAZAAAAAM!!!";
      }

      if (imageInfo) {
        await ctx.sock.sendMessage(destinationJid, {
          image: buffer,
          caption
        });
      } else if (videoInfo) {
        await ctx.sock.sendMessage(destinationJid, {
          video: buffer,
          caption
        });
      } else if (audioInfo) {
        await ctx.sock.sendMessage(destinationJid, {
          audio: buffer,
          mimetype: audioInfo.mimetype || "audio/mp4",
          ptt: audioInfo.ptt || false
        });
      } else if (docInfo) {
        await ctx.sock.sendMessage(destinationJid, {
          document: buffer,
          mimetype: docInfo.mimetype || "application/octet-stream",
          fileName: docInfo.fileName || "revealed_file"
        });
      }

      // Only send a follow-up reply if it's not a private or public silent command
      if (mode !== "private" && mode !== "public_silent" && mode !== "public_shazam") {
        await sendBotReply(
          ctx.sock,
          ctx.from,
          `🔓 Decrypted and sent the ${sourceLabel} privately to your DM. Check your private chat!`
        );
      }

    } catch (err) {
      console.error("Failed to decrypt view-once media:", err);
      if (mode !== "private" && mode !== "public_silent") {
        try {
          await ctx.sock.sendMessage(destinationJid, {
            text: `⚠️ Error: The view-once media could not be decrypted or downloaded. It may have expired, already been viewed, or been deleted from the WhatsApp servers.`
          });
        } catch (_) {}

        await sendBotReply(
          ctx.sock,
          ctx.from,
          "⚠️ Failed to reveal media."
        );
      }
    }
  }
});

// ── CLEANUP NAMES ──
registerCommand({
  name: "cleanupnames",
  requiresAdmin: true,
  handler: async (ctx) => {
    try {
      const allContacts = await redis.hgetall("contact_names");
      const adminEnv = process.env.ADMIN_JIDS || "";
      const adminJids = adminEnv
        .split(",")
        .map((s) => s.trim().toLowerCase());

      let deletedCount = 0;
      for (const [jid, name] of Object.entries(allContacts)) {
        if (name === "Ara Ara") {
          const isActualAdmin = adminJids.some((adminJid) => {
            return (
              jid.toLowerCase() === adminJid ||
              jid.toLowerCase().startsWith(adminJid.split("@")[0])
            );
          });

          if (!isActualAdmin) {
            await redis.hdel("contact_names", jid);
            deletedCount++;
          }
        }
      }

      await sendBotReply(
        ctx.sock,
        ctx.from,
        `✅ Cleaned up contact name cache in Redis. Deleted ${deletedCount} incorrect "Ara Ara" mappings.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendBotReply(ctx.sock, ctx.from, `❌ Failed to clean up name cache:\n${msg}`);
    }
  }
});

// ── SET NAME ──
registerCommand({
  name: "setname",
  requiresAdmin: true,
  handler: async (ctx) => {
    const jid = ctx.cmdArgs[0];
    const name = ctx.cmdArgs.slice(1).join(" ").trim();

    if (!jid || !name) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage: !setname <JID/LID> <New Name>\nExample: !setname 136249264357588@lid Sheik Rizwan"
      );
      return;
    }

    try {
      const normalized = normalizeJid(jid) as string;
      await redis.hset("contact_names", normalized, name);
      
      // Also try resolving it to Phone JID to map both JIDs
      if (normalized.endsWith("@lid")) {
        try {
          const { resolvePhoneJidFromLid } = await import("../../../storage/core/rbacRepository");
          const phoneJid = await resolvePhoneJidFromLid(normalized);
          if (phoneJid) {
            await redis.hset("contact_names", phoneJid, name);
          }
        } catch (_) {}
      } else if (normalized.endsWith("@s.whatsapp.net")) {
        // Also map reverse if LID is known in the DB
        try {
          const pool = (await import("../../../storage/db")).getPool();
          if (pool) {
            const res = await pool.query(
              "SELECT lid FROM wa_lid_phone_map WHERE phone_jid = $1 LIMIT 1",
              [normalized]
            );
            const lid = res.rows[0]?.lid;
            if (lid) {
              await redis.hset("contact_names", lid, name);
            }
          }
        } catch (_) {}
      }

      await sendBotReply(
        ctx.sock,
        ctx.from,
        `✅ Successfully set contact name for ${normalized} to "${name}" in cache.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendBotReply(ctx.sock, ctx.from, `❌ Failed to set contact name:\n${msg}`);
    }
  }
});

// ── SET MENTOR-NOTIFY GROUP ──
// !notify -id <groupId>  → route new-member notices to that allowlisted group
// !notify off            → disable notices
// !notify                → show the current target
registerCommand({
  name: "notify",
  requiresAdmin: true,
  handler: async (ctx) => {
    const arg1 = (ctx.cmdArgs[0] || "").toLowerCase();

    // Show current target
    if (!arg1) {
      const current = await getSetting(INTRO_NOTIFY_SETTING_KEY);
      const envFallback = process.env.INTRO_NOTIFY_GROUP_JID || "";
      const active = current || envFallback;
      await sendBotReply(
        ctx.sock,
        ctx.from,
        active
          ? `Member-join notices go to: ${active}${current ? "" : " (from env)"}\n\n!notify -id <groupId> to change · !notify off to disable`
          : "Member-join notices are OFF.\n\nUse !notify -id <groupId> (see !listgroups) to set the mentor group.",
      );
      return;
    }

    // Disable
    if (arg1 === "off" || arg1 === "-off") {
      await deleteSetting(INTRO_NOTIFY_SETTING_KEY);
      await sendBotReply(ctx.sock, ctx.from, "Member-join notices disabled.");
      return;
    }

    // Set by allowlisted group id
    const match = ctx.cmdArgs.join(" ").match(/^-id\s+(\d+)$/i);
    if (!match) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        "Usage:\n!notify -id <groupId>  (target group, see !listgroups)\n!notify off  (disable)\n!notify  (show current)",
      );
      return;
    }

    const groupId = parseInt(match[1], 10);
    const entry = groupConfig.getGroupEntryById(groupId);
    if (!entry) {
      await sendBotReply(
        ctx.sock,
        ctx.from,
        `No group found in the allowlist with ID ${groupId}. Use !listgroups to see ids.`,
      );
      return;
    }

    const ok = await setSetting(INTRO_NOTIFY_SETTING_KEY, entry.jid);
    await sendBotReply(
      ctx.sock,
      ctx.from,
      ok
        ? `Member-join notices will now go to Group ID ${groupId} (${entry.jid}).`
        : "Failed to save the setting. Check the database connection.",
    );
  },
});
