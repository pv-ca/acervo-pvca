import test from "node:test";
import assert from "node:assert/strict";
import { parseDiary, stars, fetchDiary } from "./lib/letterboxd-diary.mjs";

const item = (title, tmdb, extra = "") => `<item>
  <title>${title}, 1957 - ★★★★½</title>
  <link>https://letterboxd.com/pvca/film/x/</link>
  <letterboxd:watchedDate>2026-09-12</letterboxd:watchedDate>
  <letterboxd:filmTitle>${title}</letterboxd:filmTitle>
  <letterboxd:filmYear>1957</letterboxd:filmYear>
  <letterboxd:memberRating>4.5</letterboxd:memberRating>
  <letterboxd:memberLike>Yes</letterboxd:memberLike>
  <tmdb:movieId>${tmdb}</tmdb:movieId>
  <description><![CDATA[ <p><img src="https://a.ltrbxd.com/p.jpg?v=1&amp;x=2"/></p> <p>Private review text</p> ]]></description>
  ${extra}</item>`;
const list = `<item><title>Acervo PVCA</title><link>https://letterboxd.com/pvca/list/acervo-pvca/</link></item>`;

test("keeps films, skips lists, matches the catalog by TMDB id", () => {
  const catalog = [{ slug: "12-angry-men-1957", tmdbId: 389 }];
  const diary = parseDiary(
    `<rss>${item("12 Angry Men", 389)}${list}${item("Man&#039;s Favorite Sport?", 7)}</rss>`,
    catalog
  );
  assert.equal(diary.length, 2);
  assert.equal(diary[0].film.slug, "12-angry-men-1957");
  assert.equal(diary[0].rating, 4.5);
  assert.equal(diary[0].liked, true);
  assert.equal(diary[0].poster, "https://a.ltrbxd.com/p.jpg?v=1&x=2");
  assert.equal(diary[1].title, "Man's Favorite Sport?");
  assert.equal(diary[1].film, undefined);
  assert.ok(!JSON.stringify(diary).includes("Private review"));
});

test("respects the limit and renders half stars", () => {
  const xml = Array.from({ length: 12 }, (_, i) => item(`F${i}`, i)).join("");
  assert.equal(parseDiary(xml, [], 8).length, 8);
  assert.equal(stars(4.5), "★★★★½");
  assert.equal(stars(3), "★★★");
  assert.equal(stars(undefined), "");
});

test("zero entries requested produces an empty diary", () => {
  assert.deepEqual(parseDiary(item("Film", 389), [], 0), []);
});

test("untrusted feed cannot emit executable links or invalid ratings", () => {
  const xml = item("Film &#99999999;", 389)
    .replace("https://letterboxd.com/pvca/film/x/", "javascript:alert(1)")
    .replace("https://a.ltrbxd.com/p.jpg?v=1&amp;x=2", "javascript:alert(1)")
    .replace("<letterboxd:memberRating>4.5", "<letterboxd:memberRating>NaN");
  const [entry] = parseDiary(xml, []);
  assert.equal(entry.url, "https://letterboxd.com/pvca/films/diary/");
  assert.equal(entry.poster, undefined);
  assert.equal(entry.rating, undefined);
  assert.equal(stars(-1), "");
  assert.equal(stars(6), "");
});

test("HTTP feed errors omit the diary without breaking the build", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Unavailable", { status: 503 })
  );
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await fetchDiary([]), []);
});

test("invalid watch dates cannot crash static rendering", () => {
  const xml = item("Film", 389).replace("2026-09-12", "2026-02-31");
  assert.equal(parseDiary(xml, [])[0].watched, undefined);
});
