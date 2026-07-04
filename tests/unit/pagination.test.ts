import { describe, it, expect } from "vitest";
import { paginate, pageFooter, PAGINATION_MAX_VIEW } from "../../services/DKB/pagination";

describe("paginate", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it("uses the shared max view as page size", () => {
    expect(PAGINATION_MAX_VIEW).toBe(20);
    const p1 = paginate(items, 1);
    expect(p1.pageItems.length).toBe(20);
    expect(p1.totalPages).toBe(3);
    expect(p1.total).toBe(45);
  });

  it("returns the correct slice per page", () => {
    expect(paginate(items, 2).pageItems[0]).toBe(21);
    expect(paginate(items, 3).pageItems).toEqual([41, 42, 43, 44, 45]);
  });

  it("clamps out-of-range pages", () => {
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate([], 1)).toMatchObject({ page: 1, totalPages: 1, total: 0 });
  });

  it("footer only appears when more than one page", () => {
    expect(pageFooter("clubs", 1, 1)).toBe("");
    expect(pageFooter("clubs", 1, 3)).toContain("Page 1/3");
    expect(pageFooter("clubs", 3, 3)).not.toContain("!next");
  });
});
