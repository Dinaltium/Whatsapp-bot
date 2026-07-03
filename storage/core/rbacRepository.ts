import { getPool } from "../db";

export const RBAC_PERMISSIONS = [
  "mentor.manage",
  "allowlist.manage",
  "bot.manage",
  "db.manage",
  "role.manage",
  "club.manage",
  "event.manage",
] as const;

export type RbacPermission = (typeof RBAC_PERMISSIONS)[number];

/**
 * Permissions that confer administrative control. Assigning any role bearing
 * one of these is restricted to hard-admins (the owner) — a role.manage holder
 * must never be able to propagate admin-level power to another user. Only
 * event/club "directory viewing" permissions are considered non-privileged.
 */
export const PRIVILEGED_PERMISSIONS: readonly string[] = [
  "role.manage",
  "mentor.manage",
  "allowlist.manage",
  "bot.manage",
  "db.manage",
];

export interface RbacRole {
  name: string;
  description?: string;
  permissions: string[];
  created_at?: string;
}

export function normalizeRoleName(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, "_");
}

export function isValidRoleName(role: string): boolean {
  return /^[a-z][a-z0-9_-]{1,31}$/.test(role);
}

export function isValidPermission(permission: string): permission is RbacPermission {
  return (RBAC_PERMISSIONS as readonly string[]).includes(permission);
}

export async function addManagedRole(
  jid: string,
  role: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!jid || !isValidRoleName(normalizedRole)) return false;
  try {
    const exists = await pool.query(
      `SELECT 1 FROM rbac_roles WHERE name = $1 LIMIT 1`,
      [normalizedRole],
    );
    if (exists.rows.length === 0) return false;
    await pool.query(
      `INSERT INTO rbac_user_roles (jid, role_name)
       VALUES ($1, $2)
       ON CONFLICT (jid, role_name) DO NOTHING`,
      [jid, normalizedRole],
    );
    return true;
  } catch (error) {
    console.error("⚠️ Error adding managed role:", error);
    return false;
  }
}

/**
 * Stores a LID → phone JID mapping so that group members who appear
 * as @lid senders can be resolved to their canonical phone JID for
 * RBAC permission checks.
 */
export async function storeLidPhoneMapping(
  lid: string,
  phoneJid: string,
): Promise<void> {
  const pool = getPool();
  if (!pool || !lid || !phoneJid) return;
  if (!lid.endsWith("@lid")) return;
  if (!phoneJid.endsWith("@s.whatsapp.net")) return;
  try {
    await pool.query(
      `INSERT INTO wa_lid_phone_map (lid, phone_jid, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (lid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, updated_at = NOW()`,
      [lid, phoneJid],
    );
  } catch (error) {
    console.error("⚠️ Error storing LID phone mapping:", error);
  }
}

/**
 * Resolves a @lid JID to its canonical @s.whatsapp.net JID.
 * Returns null if no mapping is found.
 */
export async function resolvePhoneJidFromLid(
  lid: string,
): Promise<string | null> {
  const pool = getPool();
  if (!pool || !lid || !lid.endsWith("@lid")) return null;
  try {
    const res = await pool.query(
      `SELECT phone_jid FROM wa_lid_phone_map WHERE lid = $1 LIMIT 1`,
      [lid],
    );
    return (res.rows[0]?.phone_jid as string) || null;
  } catch (error) {
    console.error("⚠️ Error resolving LID:", error);
    return null;
  }
}

export async function isWorkerAuthorized(
  jid: string,
  role: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!jid || !isValidRoleName(normalizedRole)) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM rbac_user_roles WHERE jid = $1 AND role_name = $2 LIMIT 1`,
      [jid, normalizedRole],
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error("⚠️ Error checking worker authorization:", error);
    return false;
  }
}

export async function getUsersWithRole(
  role: string,
): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole)) return [];
  try {
    const res = await pool.query(
      `SELECT jid FROM rbac_user_roles WHERE role_name = $1`,
      [normalizedRole],
    );
    return res.rows.map((row) => row.jid);
  } catch (error) {
    console.error("Error fetching users with role:", error);
    return [];
  }
}

export async function getUserRoles(
  jid: string,
): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT role_name FROM rbac_user_roles WHERE jid = $1 ORDER BY role_name ASC`,
      [jid],
    );
    return res.rows.map((row) => row.role_name);
  } catch (error) {
    console.error("Error fetching custom roles for user:", error);
    return [];
  }
}

export function listAvailablePermissions(): string[] {
  return [...RBAC_PERMISSIONS];
}

export async function createManagedRole(
  role: string,
  description: string = "",
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole)) return false;

  try {
    await pool.query(
      `INSERT INTO rbac_roles (name, description)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
      [normalizedRole, description || null],
    );
    return true;
  } catch (error) {
    console.error("Error creating managed role:", error);
    return false;
  }
}

export async function deleteManagedRole(role: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole)) return false;

  try {
    const res = await pool.query(`DELETE FROM rbac_roles WHERE name = $1`, [
      normalizedRole,
    ]);
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("Error deleting managed role:", error);
    return false;
  }
}

export async function managedRoleExists(role: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole)) return false;

  try {
    const res = await pool.query(
      `SELECT 1 FROM rbac_roles WHERE name = $1 LIMIT 1`,
      [normalizedRole],
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error("Error checking managed role:", error);
    return false;
  }
}

export async function grantRolePermission(
  role: string,
  permission: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole) || !isValidPermission(permission)) {
    return false;
  }

  try {
    await pool.query(
      `INSERT INTO rbac_role_permissions (role_name, permission)
       VALUES ($1, $2)
       ON CONFLICT (role_name, permission) DO NOTHING`,
      [normalizedRole, permission],
    );
    return true;
  } catch (error) {
    console.error("Error granting role permission:", error);
    return false;
  }
}

export async function revokeRolePermission(
  role: string,
  permission: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole) || !isValidPermission(permission)) {
    return false;
  }

  try {
    const res = await pool.query(
      `DELETE FROM rbac_role_permissions WHERE role_name = $1 AND permission = $2`,
      [normalizedRole, permission],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("Error revoking role permission:", error);
    return false;
  }
}

export async function revokeManagedRole(
  jid: string,
  role: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const normalizedRole = normalizeRoleName(role);
  if (!jid || !isValidRoleName(normalizedRole)) return false;

  try {
    const res = await pool.query(
      `DELETE FROM rbac_user_roles WHERE jid = $1 AND role_name = $2`,
      [jid, normalizedRole],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("Error revoking managed role:", error);
    return false;
  }
}

export async function userHasPermission(
  jid: string,
  permission: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool || !jid || !isValidPermission(permission)) return false;

  // If the caller is a @lid sender, try to resolve to phone JID first.
  let effectiveJid = jid;
  if (jid.endsWith("@lid")) {
    const resolved = await resolvePhoneJidFromLid(jid);
    if (resolved) {
      effectiveJid = resolved;
    }
  }

  try {
    const res = await pool.query(
      `SELECT 1
       FROM rbac_user_roles ur
       JOIN rbac_role_permissions rp ON rp.role_name = ur.role_name
       WHERE ur.jid = $1 AND rp.permission = $2
       LIMIT 1`,
      [effectiveJid, permission],
    );
    if (res.rows.length > 0) return true;

    if (effectiveJid !== jid) {
      const res2 = await pool.query(
        `SELECT 1
         FROM rbac_user_roles ur
         JOIN rbac_role_permissions rp ON rp.role_name = ur.role_name
         WHERE ur.jid = $1 AND rp.permission = $2
         LIMIT 1`,
        [jid, permission],
      );
      return res2.rows.length > 0;
    }

    return false;
  } catch (error) {
    console.error("Error checking RBAC permission:", error);
    return false;
  }
}

export async function listManagedRoles(): Promise<RbacRole[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT r.name, r.description, r.created_at,
              COALESCE(
                ARRAY_AGG(rp.permission ORDER BY rp.permission)
                FILTER (WHERE rp.permission IS NOT NULL),
                ARRAY[]::TEXT[]
              ) AS permissions
       FROM rbac_roles r
       LEFT JOIN rbac_role_permissions rp ON rp.role_name = r.name
       GROUP BY r.name, r.description, r.created_at
       ORDER BY r.name ASC`,
    );
    return res.rows as RbacRole[];
  } catch (error) {
    console.error("Error listing managed roles:", error);
    return [];
  }
}

/**
 * True if the named role carries any administrative (privileged) permission.
 * Used to gate role assignment so only the owner can hand out admin power.
 */
export async function roleHasPrivilegedPermission(
  role: string,
): Promise<boolean> {
  const managed = await getManagedRole(role);
  if (!managed) return false;
  return managed.permissions.some((p) => PRIVILEGED_PERMISSIONS.includes(p));
}

export async function getManagedRole(role: string): Promise<RbacRole | null> {
  const pool = getPool();
  if (!pool) return null;
  const normalizedRole = normalizeRoleName(role);
  if (!isValidRoleName(normalizedRole)) return null;

  try {
    const res = await pool.query(
      `SELECT r.name, r.description, r.created_at,
              COALESCE(
                ARRAY_AGG(rp.permission ORDER BY rp.permission)
                FILTER (WHERE rp.permission IS NOT NULL),
                ARRAY[]::TEXT[]
              ) AS permissions
       FROM rbac_roles r
       LEFT JOIN rbac_role_permissions rp ON rp.role_name = r.name
       WHERE r.name = $1
       GROUP BY r.name, r.description, r.created_at
       LIMIT 1`,
      [normalizedRole],
    );
    return (res.rows[0] as RbacRole) || null;
  } catch (error) {
    console.error("Error fetching managed role:", error);
    return null;
  }
}
