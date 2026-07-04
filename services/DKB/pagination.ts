// Shared pagination for the DK24 directories (clubs/events/projects/mentors).
// One page size for all of them, env-tunable.
export const PAGINATION_MAX_VIEW = Number(process.env.PAGINATION_MAX_VIEW) || 20;

/** Minimal session slice the paginated directory handlers need. */
export interface DirectorySession {
  lastQuery?: {
    type: "mentors" | "clubs" | "events" | "projects";
    filter?: string;
    page: number;
  };
}

export interface PageInfo<T> {
  pageItems: T[];
  page: number;
  totalPages: number;
  total: number;
}

/** Clamps `page` into range and slices `items` for that page. */
export function paginate<T>(items: T[], page: number): PageInfo<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGINATION_MAX_VIEW));
  let p = page < 1 ? 1 : page;
  if (p > totalPages) p = totalPages;
  const start = (p - 1) * PAGINATION_MAX_VIEW;
  return {
    pageItems: items.slice(start, start + PAGINATION_MAX_VIEW),
    page: p,
    totalPages,
    total,
  };
}

/** Standard footer hint shown when more pages exist. */
export function pageFooter(
  listCmd: string,
  page: number,
  totalPages: number,
): string {
  if (totalPages <= 1) return "";
  const parts: string[] = [`Page ${page}/${totalPages}`];
  if (page < totalPages) {
    parts.push(`Type \`!next\` or \`!page ${page + 1}\` for more.`);
  }
  return parts.join(" — ");
}
