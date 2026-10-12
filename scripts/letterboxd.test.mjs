import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewFor,
  letterboxdCsv,
  letterboxdFilename,
  formatSize,
  formatResolution,
} from "./lib/letterboxd.mjs";

const copy = (id, size_gib, resolution, subtitle_languages = []) => ({
  id,
  size_gib,
  resolution,
  subtitle_languages,
});
const link = (provider, url, copy_id) => ({ provider, url, copy_id });
const ficha = (slug) =>
  `<a href="https://pv-ca.github.io/acervo-pvca/filmes/${slug}/">Ver a ficha do filme no Acervo PVCA</a>`;

test("review links to the ficha and describes the copy, pt-BR subtitles first", () => {
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [copy("a", 17.8, "1080p", ["en", "fr", "pt-BR"])],
      external_links: [link("internet_archive", "https://archive.org/x", "a")],
    }),
    ficha("x-1950") + "<br>19,1 GB · 1080p · Legendas: PT-BR, EN, FR"
  );
});

test("no subtitles omits the subtitle part; sizes below 1 GB use MB", () => {
  assert.equal(formatSize(0.3725), "400 MB");
  assert.equal(formatResolution("720×544"), "544p");
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [copy("a", 0.3725, "480p")],
      external_links: [link("google_drive", "https://drive/x", "a")],
    }),
    ficha("x-1950") + "<br>400 MB · 480p"
  );
});

test("several public copies: the largest is described, never a copy without a link", () => {
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [
        copy("hd", 7.65, "1080p", ["en"]),
        copy("uhd", 80.3, "2160p", ["en", "pt-BR"]),
        copy("gone-drive", 120, "2160p", ["fr"]),
      ],
      external_links: [
        link("internet_archive", "https://archive.org/hd", "hd"),
        link("google_drive", "https://drive/x", "uhd"),
        link("internet_archive", "https://archive.org/uhd", "uhd"),
      ],
    }),
    ficha("x-1950") + "<br>86,2 GB · 2160p · Legendas: PT-BR, EN"
  );
});

test("a film with no public copy gets the ficha link alone", () => {
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [copy("x-local", 1, "1080p", ["en"])],
      external_links: [],
    }),
    ficha("x-1950")
  );
});

const parse = (csv) => {
  const rows = [];
  let row = [""],
    quoted = false;
  for (let i = 1; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') row[row.length - 1] += csv[++i];
      else if (char === '"') quoted = false;
      else row[row.length - 1] += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") row.push("");
    else if (char === "\r") {
      rows.push(row);
      row = [""];
      i++;
    } else row[row.length - 1] += char;
  }
  return rows;
};

test("csv exports every catalog film, with or without a known URI or copy", () => {
  const films = Array.from({ length: 600 }, (_, index) => ({
    tmdb_id: index + 1,
    slug: `film-${index + 1}`,
    copies: [copy("a", 1, "480p", ["en", "pt-BR"])],
    external_links: [
      link("internet_archive", "https://archive.org/details/x", "a"),
    ],
  }));
  films[1] = {
    tmdb_id: 2,
    slug: "film-2",
    copies: [copy("a-local", 1, "480p")],
    external_links: [],
  };
  const { csv, count } = letterboxdCsv(films, {
    1: "https://letterboxd.com/film/one/",
  });
  assert.ok(csv.startsWith("﻿LetterboxdURI,tmdbID,Review\r\n"));
  const rows = parse(csv).slice(1);
  assert.equal(count, 600);
  assert.equal(rows.length, count);
  assert.ok(rows.every((row) => row.length === 3));
  assert.deepEqual(rows[0], [
    "https://letterboxd.com/film/one/",
    "1",
    ficha("film-1") + "<br>1,1 GB · 480p · Legendas: PT-BR, EN",
  ]);
  assert.deepEqual(rows[1], ["", "2", ficha("film-2")]);
  assert.deepEqual(rows[599].slice(0, 2), ["", "600"]);
  assert.doesNotMatch(csv, /em envio|drive\.google|archive\.org/);
});

test("filename matches the Downloads convention", () => {
  assert.equal(
    letterboxdFilename(425, new Date(2026, 8, 20)),
    "Acervo PVCA — Catálogo Mestre — 425 títulos — 2026-09-20.csv"
  );
});
