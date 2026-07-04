import { describe, it, expect } from "vitest";
import { PRIVILEGED_PERMISSIONS } from "../../storage/core/rbacRepository";

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
});
