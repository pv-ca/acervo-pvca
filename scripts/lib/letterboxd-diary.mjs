// Recent diary entries from the public Letterboxd RSS feed, read at build time.
// Each entry is matched to the catalog by TMDB id, so films in the collection
// link to their ficha. Review text is never kept: only title, year, rating,
// like and watch date.
export const DIARY_FEED = "https://letterboxd.com/pvca/rss/";
export const DIARY_URL = "https://letterboxd.com/pvca/films/diary/";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES[code] ?? match;
    const point =
      code[1].toLowerCase() === "x"
        ? parseInt(code.slice(2), 16)
        : Number(code.slice(1));
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : match;
  });
const safeUrl = (value, hosts) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      hosts.includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
const validRating = (rating) =>
  Number.isFinite(rating) &&
  rating >= 0 &&
  rating <= 5 &&
  Number.isInteger(rating * 2);
const watchDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
};
const tag = (item, name) => {
  const match = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1].trim()) : undefined;
};

export function parseDiary(xml, catalog, limit = 8) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const byTmdb = new Map(
    catalog.filter((film) => film.tmdbId).map((film) => [film.tmdbId, film])
  );
  const entries = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tag(item, "letterboxd:filmTitle");
    if (!title) continue; // lists, not films
    const ratingText = tag(item, "letterboxd:memberRating");
    const rating = ratingText ? Number(ratingText) : undefined;
    const tmdbId = Number(tag(item, "tmdb:movieId"));
    const poster = item.match(/<img src="([^"]+)"/)?.[1];
    entries.push({
      title,
      year: Number(tag(item, "letterboxd:filmYear")) || undefined,
      rating: validRating(rating) ? rating : undefined,
      liked: tag(item, "letterboxd:memberLike") === "Yes",
      watched: watchDate(tag(item, "letterboxd:watchedDate")),
      url:
        safeUrl(tag(item, "link"), ["letterboxd.com", "www.letterboxd.com"]) ||
        DIARY_URL,
      poster: poster ? safeUrl(decode(poster), ["a.ltrbxd.com"]) : undefined,
      film: byTmdb.get(tmdbId),
    });
    if (entries.length === limit) break;
  }
  return entries;
}

// A failed or slow feed must never break the build: the section is left out.
export async function fetchDiary(catalog, { limit = 8, timeout = 10000 } = {}) {
  try {
    const response = await fetch(DIARY_FEED, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseDiary(await response.text(), catalog, limit);
  } catch (error) {
    console.warn(`Letterboxd diary skipped: ${error.message}`);
    return [];
  }
}

export const stars = (rating) =>
  !validRating(rating)
    ? ""
    : "★".repeat(Math.floor(rating)) + (rating % 1 ? "½" : "");
