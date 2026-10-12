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

test("single link: size, resolution and pt-BR-first subtitles", () => {
  assert.equal(
    reviewFor({
      copies: [copy("a", 17.8, "1080p", ["en", "fr", "pt-BR"])],
      external_links: [link("internet_archive", "https://archive.org/x", "a")],
    }),
    '<a href="https://archive.org/x">Internet Archive</a><br>19,1 GB · 1080p · Legendas: PT-BR, EN, FR'
  );
});

test("no subtitles omits the subtitle part; sizes below 1 GB use MB", () => {
  assert.equal(formatSize(0.3725), "400 MB");
  assert.equal(formatResolution("720×544"), "544p");
  assert.equal(
    reviewFor({
      copies: [copy("a", 0.3725, "480p")],
      external_links: [link("google_drive", "https://drive/x", "a")],
    }),
    '<a href="https://drive/x">Google Drive</a><br>400 MB · 480p'
  );
});

test("two links agree: one value; differ: labelled per provider", () => {
  const links = [
    link("internet_archive", "https://archive.org/x", "ia"),
    link("google_drive", "https://drive/x", "dr"),
  ];
  assert.equal(
    reviewFor({
      copies: [
        copy("dr", 27.0, "1080p", ["en"]),
        copy("ia", 27.0, "1080p", ["en"]),
      ],
      external_links: links,
    }),
    '<a href="https://drive/x">Google Drive</a> · <a href="https://archive.org/x">Internet Archive</a><br>29,0 GB · 1080p · Legendas: EN'
  );
  assert.equal(
    reviewFor({
      copies: [
        copy("dr", 1.5, "1080p", ["en", "zh"]),
        copy("ia", 56.1, "2160p", ["en", "pt-BR"]),
      ],
      external_links: links,
    }),
    '<a href="https://drive/x">Google Drive</a> · <a href="https://archive.org/x">Internet Archive</a><br>1,6 GB (Drive) / 60,2 GB (Archive) · 1080p (Drive) / 2160p (Archive) · Legendas: EN, ZH (Drive) / PT-BR, EN (Archive)'
  );
});

test("copies without a current public link are never described", () => {
  assert.equal(
    reviewFor({ copies: [copy("x-local", 1, "1080p")], external_links: [] }),
    ""
  );
  // A Drive copy whose folder is gone or private leaves only the Archive link.
  assert.equal(
    reviewFor({
      copies: [
        copy("x-drive", 1, "1080p", ["fr"]),
        copy("x-archive", 1, "1080p"),
      ],
      external_links: [
        link("internet_archive", "https://archive.org/x", "x-archive"),
      ],
    }),
    '<a href="https://archive.org/x">Internet Archive</a><br>1,1 GB · 1080p'
  );
});

test("a provider with two copies names each by resolution, largest first", () => {
  assert.equal(
    reviewFor({
      copies: [
        copy("hd", 7.65, "1080p", ["en"]),
        copy("uhd", 80.3, "2160p", ["en", "pt-BR"]),
      ],
      external_links: [
        link("internet_archive", "https://archive.org/hd", "hd"),
        link("google_drive", "https://drive/x", "uhd"),
        link("internet_archive", "https://archive.org/uhd", "uhd"),
      ],
    }),
    '<a href="https://drive/x">Google Drive</a> · <a href="https://archive.org/uhd">Internet Archive (2160p)</a> · <a href="https://archive.org/hd">Internet Archive (1080p)</a><br>86,2 GB (2160p) / 8,2 GB (1080p) · Legendas: PT-BR, EN (2160p) / EN (1080p)'
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
    copies: [copy("a", 1, "480p", ["en", "pt-BR"])],
    external_links: [
      link("internet_archive", "https://archive.org/details/x", "a"),
      link("google_drive", "https://drive/x", "a"),
    ],
  }));
  films[1] = {
    tmdb_id: 2,
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
    '<a href="https://drive/x">Google Drive</a> · <a href="https://archive.org/details/x">Internet Archive</a><br>1,1 GB · 480p · Legendas: PT-BR, EN',
  ]);
  assert.deepEqual(rows[1], ["", "2", ""]);
  assert.deepEqual(rows[599].slice(0, 2), ["", "600"]);
  assert.doesNotMatch(csv, /em envio/);
});

test("filename matches the Downloads convention", () => {
  assert.equal(
    letterboxdFilename(425, new Date(2026, 8, 20)),
    "Acervo PVCA — Catálogo Mestre — 425 títulos — 2026-09-20.csv"
  );
});
