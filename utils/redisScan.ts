import { redis } from "../storage/redisClient";

export async function scanHashForMatches(
  hashKey: string,
  query: string,
  cursor: number,
  pageSize: number = 10,
): Promise<{
  results: [string, string][];
  nextCursor: number;
  hasMore: boolean;
}> {
  const allMatches: [string, string][] = [];
  let currentCursor = cursor;

  do {
    const [nextCursorStr, items] = await (redis as any).hscan(
      hashKey,
      currentCursor,
      "MATCH",
      `*${query}*`,
      "COUNT",
      100,
    );
    for (let i = 0; i < items.length; i += 2) {
      allMatches.push([items[i], items[i + 1]]);
    }
    currentCursor = parseInt(nextCursorStr, 10);
    if (allMatches.length >= pageSize) break;
  } while (currentCursor !== 0);

  return {
    results: allMatches.slice(0, pageSize),
    nextCursor: currentCursor,
    hasMore: currentCursor !== 0 || allMatches.length > pageSize,
  };
}
