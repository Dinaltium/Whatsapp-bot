import { createManagedRole, grantRolePermission, managedRoleExists } from "../../storage/core/rbacRepository";

export interface RoleSession {
  roleName: string;
  step: "select_permissions";
  tries: number;
}

export interface PermissionCategory {
  id: number;
  name: string;
  permissions: string[];
  description: string;
  subcommands: string[];
}

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    id: 1,
    name: "Event Commands",
    permissions: ["event.manage"],
    description: "Allows viewing and querying event lists and details.",
    subcommands: [
      "!events [monthYear] - List chronological network events",
      "!event <name> - Get detailed information and registration links for an event",
    ],
  },
  {
    id: 2,
    name: "Club Commands",
    permissions: ["club.manage"],
    description: "Allows viewing and querying club list and spotlights.",
    subcommands: [
      "!clubs - List all official member communities in the DK24 network",
      "!club <name> - Get detailed spotlight card for a specific member community",
    ],
  },
];

export async function handleCreateCommand(
  roleArg: string,
  session: any,
  sendReply: (text: string) => Promise<void>,
): Promise<void> {
  const roleName = roleArg.trim().toLowerCase();

  // 1. Verify if roleName contains valid alphanumeric characters/underscores
  const isValidRole = /^[a-z0-9_-]+$/.test(roleName);
  if (!isValidRole) {
    await sendReply("Error: Role name must be alphanumeric, containing only letters, numbers, hyphens, or underscores.");
    return;
  }

  // 2. Check if the role already exists in DB
  try {
    const { managedRoleExists } = await import("../../storage/core/rbacRepository");
    const exists = await managedRoleExists(roleName);
    if (exists) {
      await sendReply(`Error: Role "${roleName}" already exists.`);
      return;
    }
  } catch (err) {
    console.error("Error checking role existence:", err);
  }

  // 3. Initiate the multi-turn session
  session.pendingCreateRole = {
    roleName: roleName,
    step: "select_permissions",
    tries: 0,
  };

  await sendReply(
    `Role "${roleName}" has been initiated. Which commands do you want to add to this role?\n\n` +
    `1. Event Commands\n` +
    `2. Club Commands\n\n` +
    `Respond with:\n` +
    `• !display -id <number> (to view category commands)\n` +
    `• !select -id <numbers> (to assign categories, e.g. !select -id 1 or !select -id 1,2)`
  );
}

export async function handleRoleDialogue(
  text: string,
  session: any,
  sendReply: (text: string) => Promise<void>,
): Promise<boolean> {
  if (!session.pendingCreateRole) return false;

  const pending = session.pendingCreateRole;
  const normalizedInput = text.trim().toLowerCase();

  // 1. Handle Display command
  const displayMatch = normalizedInput.match(/^!?display\s+-id\s+(\d+)$/i);
  if (displayMatch) {
    const categoryId = parseInt(displayMatch[1], 10);
    const cat = PERMISSION_CATEGORIES.find(c => c.id === categoryId);
    if (cat) {
      await sendReply(
        `${cat.name} Category (ID: ${cat.id}) includes:\n` +
        cat.subcommands.map(cmd => `• ${cmd}`).join("\n")
      );
    } else {
      pending.tries++;
      if (pending.tries >= 3) {
        delete session.pendingCreateRole;
        await sendReply("Wrong ID number limit exceeded. Role creation cancelled.");
      } else {
        await sendReply(
          `Wrong ID number. Please select 1 for Event Commands or 2 for Club Commands (Tries remaining: ${3 - pending.tries}).\n(Enter !display -id <id> or !select -id <ids>)`
        );
      }
    }
    return true;
  }

  // 2. Handle Select command
  const selectMatch = normalizedInput.match(/^!?select\s+-id\s+([\d\s,]+)$/i);
  if (selectMatch) {
    const rawIds = selectMatch[1];
    const ids = rawIds.split(",").map(idStr => parseInt(idStr.trim(), 10)).filter(id => !isNaN(id));

    // Validate that all parsed IDs exist in categories
    const allValid = ids.length > 0 && ids.every(id => PERMISSION_CATEGORIES.some(c => c.id === id));

    if (!allValid) {
      pending.tries++;
      if (pending.tries >= 3) {
        delete session.pendingCreateRole;
        await sendReply("Wrong ID number limit exceeded. Role creation cancelled.");
      } else {
        await sendReply(
          `Wrong ID number. Please select from the available categories: 1 for Event Commands, 2 for Club Commands (Tries remaining: ${3 - pending.tries}).\n(Enter !select -id <id1,id2>)`
        );
      }
    } else {
      // Success: map selected categories to permissions
      const permissionsToGrant: string[] = [];
      const categoryNames: string[] = [];
      
      for (const id of ids) {
        const cat = PERMISSION_CATEGORIES.find(c => c.id === id);
        if (cat) {
          permissionsToGrant.push(...cat.permissions);
          categoryNames.push(cat.name);
        }
      }

      try {
        const { createManagedRole, grantRolePermission } = await import("../../storage/core/rbacRepository");
        const created = await createManagedRole(pending.roleName, `Managed role for ${pending.roleName}`);
        if (created) {
          for (const perm of permissionsToGrant) {
            await grantRolePermission(pending.roleName, perm);
          }
          await sendReply(
            `Successfully created role "${pending.roleName}" with permissions: ${categoryNames.join(", ")}.`
          );
        } else {
          await sendReply(`Failed to create role "${pending.roleName}" in database.`);
        }
      } catch (err) {
        console.error("Error creating role via DB:", err);
        await sendReply("Error: Failed to save role to DB.");
      }

      delete session.pendingCreateRole;
    }
    return true;
  }

  // 3. Fallback for wrong format or other commands
  pending.tries++;
  if (pending.tries >= 3) {
    delete session.pendingCreateRole;
    await sendReply("Wrong input limit exceeded. Role creation cancelled.");
  } else {
    await sendReply(
      `Invalid input. Please respond with:\n` +
      `• !display -id <number> (to view category commands)\n` +
      `• !select -id <numbers> (to assign categories, e.g. !select -id 1,2)\n` +
      `(Tries remaining: ${3 - pending.tries})`
    );
  }
  return true;
}
