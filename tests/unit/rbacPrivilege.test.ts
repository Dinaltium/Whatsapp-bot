import { describe, it, expect } from "vitest";
import { PRIVILEGED_PERMISSIONS } from "../../storage/core/rbacRepository";
import { PERMISSION_CATEGORIES } from "../../services/core/rbacService";

describe("RBAC privilege boundary", () => {
  it("admin-level permissions are marked privileged", () => {
    for (const p of [
      "role.manage",
      "mentor.manage",
      "allowlist.manage",
      "bot.manage",
      "db.manage",
    ]) {
      expect(PRIVILEGED_PERMISSIONS).toContain(p);
    }
  });

  it("directory-viewing permissions are NOT privileged", () => {
    expect(PRIVILEGED_PERMISSIONS).not.toContain("event.manage");
    expect(PRIVILEGED_PERMISSIONS).not.toContain("club.manage");
  });

  it("the createrole dialogue never exposes a privileged permission", () => {
    // This is the invariant that stops a non-admin (role.manage holder) from
    // minting a role with admin power via !role/!createrole. If someone adds a
    // privileged permission to a selectable category, this fails loudly.
    const exposed = PERMISSION_CATEGORIES.flatMap((c) => c.permissions);
    for (const perm of exposed) {
      expect(PRIVILEGED_PERMISSIONS).not.toContain(perm);
    }
  });
});
