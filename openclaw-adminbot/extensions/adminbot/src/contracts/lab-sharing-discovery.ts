export type LabSharingDiscoveryQuery = {
  query: string;
  terms: string[];
  maxHours: number | null;
  sort: "title" | "hours";
  limit: number;
};

/** Normalize filters before cursor binding and store lookup so each layer uses one meaning. */
export function parseLabSharingDiscoveryQuery(params: URLSearchParams): LabSharingDiscoveryQuery | string {
  for (const key of ["q", "max_hours", "sort", "limit"]) {
    if (params.getAll(key).length > 1) return `Provide ${key} only once.`;
  }
  const rawQuery = params.get("q") ?? "";
  if (rawQuery.length > 200) return "Use a search of at most 200 characters.";
  const query = rawQuery.trim().toLowerCase().replace(/\s+/gu, " ");
  const sort = params.get("sort") ?? "title";
  if (sort !== "title" && sort !== "hours") return "Sort by title or hours.";
  const limitText = params.get("limit") ?? "10";
  if (!/^[1-9]\d*$/u.test(limitText) || Number(limitText) > 50) return "Use a page size of 1 to 50.";
  const hoursText = params.get("max_hours");
  const maxHours = hoursText === null || hoursText === "" ? null : Number(hoursText);
  if (maxHours !== null && (!/^\d+(?:\.\d+)?$/u.test(hoursText!) || !Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 168)) {
    return "Use weekly hours greater than zero and at most 168.";
  }
  return {query, terms: query ? query.split(" ") : [], maxHours, sort, limit: Number(limitText)};
}
