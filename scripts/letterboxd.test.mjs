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
const ficha = (slug, text = "Ficha no Acervo PVCA") =>
  `<a href="https://pv-ca.github.io/acervo-pvca/filmes/${slug}/">${text}</a>`;
const DRIVE = "https://drive.google.com/drive/folders/d";
const ARCHIVE = "https://archive.org/details/a";
const anchors = {
  drive: `<a href="${DRIVE}">Google Drive</a>`,
  archive: `<a href="${ARCHIVE}">Internet Archive</a>`,
};

test("one source: its link and the copy, pt-BR subtitles first, no source label", () => {
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [copy("a", 17.8, "1080p", ["en", "fr", "pt-BR"])],
      external_links: [link("internet_archive", ARCHIVE, "a")],
    }),
    anchors.archive + "<br>19,1 GB · 1080p · Legendas: PT-BR, EN, FR"
  );
});

test("both sources: Drive first, the subtitles of each source labelled", () => {
  assert.equal(
    reviewFor({
      slug: "heaven-s-gate-1980",
      copies: [
        copy("d", 42.189986697398126, "1080p", ["en", "zh"]),
        copy("a", 42.24734884593636, "1080p", ["pt-BR", "en", "zh"]),
      ],
      external_links: [
        link("internet_archive", ARCHIVE, "a"),
        link("google_drive", DRIVE, "d"),
      ],
    }),
    `${anchors.drive} · ${anchors.archive}<br>45,4 GB · 1080p · Legendas: EN, ZH (Drive) / PT-BR, EN, ZH (Archive)`
  );
});

test("a source without subtitles drops out of the list; none at all drops the part; sizes below 1 GB use MB", () => {
  assert.equal(formatSize(0.3725), "400 MB");
  assert.equal(formatResolution("720×544"), "544p");
  const both = (driveSubs, archiveSubs) =>
    reviewFor({
      slug: "x-1950",
      copies: [
        copy("d", 1, "720p", driveSubs),
        copy("a", 2, "1080p", archiveSubs),
      ],
      external_links: [
        link("google_drive", DRIVE, "d"),
        link("internet_archive", ARCHIVE, "a"),
      ],
    });
  assert.ok(
    both([], ["pt-BR"]).endsWith("2,1 GB · 1080p · Legendas: PT-BR (Archive)")
  );
  assert.ok(both([], []).endsWith("2,1 GB · 1080p"));
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [copy("a", 0.3725, "480p")],
      external_links: [link("google_drive", DRIVE, "a")],
    }),
    anchors.drive + "<br>400 MB · 480p"
  );
});

test("two links of one source: the note links the copy it describes, with that copy's subtitles", () => {
  assert.equal(
    reviewFor({
      slug: "la-notte-1961",
      copies: [
        copy("hd", 7.65, "1080p", ["en"]),
        copy("uhd", 80.3, "2160p", ["pt-BR", "en"]),
      ],
      external_links: [
        link("internet_archive", "https://archive.org/hd", "hd"),
        link("internet_archive", "https://archive.org/uhd", "uhd"),
      ],
    }),
    '<a href="https://archive.org/uhd">Internet Archive</a><br>86,2 GB · 2160p · Legendas: PT-BR, EN'
  );
});

test("a copy without a link is never described or labelled", () => {
  assert.equal(
    reviewFor({
      slug: "x-1950",
      copies: [
        copy("hd", 7.65, "1080p", ["en"]),
        copy("uhd", 80.3, "2160p", ["en", "pt-BR"]),
        copy("gone-drive", 120, "2160p", ["fr"]),
      ],
      external_links: [link("internet_archive", ARCHIVE, "uhd")],
    }),
    anchors.archive + "<br>86,2 GB · 2160p · Legendas: PT-BR, EN"
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
    `<a href="https://archive.org/details/x">Internet Archive</a><br>1,1 GB · 480p · Legendas: PT-BR, EN`,
  ]);
  assert.deepEqual(rows[1], ["", "2", ficha("film-2")]);
  assert.deepEqual(rows[599].slice(0, 2), ["", "600"]);
  assert.doesNotMatch(csv, /em envio/);
});

test("filename matches the Downloads convention", () => {
  assert.equal(
    letterboxdFilename(425, new Date(2026, 8, 20)),
    "Acervo PVCA — Catálogo Mestre — 425 títulos — 2026-09-20.csv"
  );
});
