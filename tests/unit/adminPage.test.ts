import { describe, it, expect } from "vitest";
import { renderAdminPage } from "../../infrastructure/health/adminPage";

describe("admin page", () => {
  it("ships an inline script that actually parses", () => {
    const html = renderAdminPage();
    const js = html.split("<script>")[1].split("</script>")[0];
    // A syntax error here blanks the whole console — regression from an
    // apostrophe inside a single-quoted string in the template.
    expect(() => new Function(js)).not.toThrow();
  });

  it("starts with both views hidden and lets the script pick one", () => {
    const html = renderAdminPage();
    expect(html).toContain('id="login" class="hidden"');
    expect(html).toContain('id="app" class="hidden"');
  });
});
