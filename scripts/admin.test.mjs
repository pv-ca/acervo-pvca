import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createAdmin } from "./admin.mjs";
import { recentEntries, validateEditorial } from "./lib/editorial.mjs";
const root = new URL("../", import.meta.url);
test("recent films use supplied entry dates, not array position or resolution", () => {
  const films = [
    { title: "Old", addedAt: "2020-01-01" },
    { title: "Unknown" },
    { title: "New", addedAt: "2026-10-07" },
  ];
  assert.deepEqual(
    recentEntries(films, 2).map((f) => f.title),
    ["New", "Old"]
  );
  assert.equal(films[0].title, "Old");
  const sameDay = ["PVCA-000001", "PVCA-000003", "PVCA-000002"].map((id) => ({
    id,
    title: id === "PVCA-000003" ? "Zebra" : "Alpha " + id,
    addedAt: "2026-10-10",
  }));
  assert.deepEqual(
    recentEntries(sameDay, 3).map((f) => f.id),
    ["PVCA-000003", "PVCA-000002", "PVCA-000001"]
  );
  const config = JSON.parse(
    readFileSync(new URL("data/public/editorial.json", root))
  );
  config.recentLimit = 0;
  assert.ok(validateEditorial(config).length);
});
test("local editor guards origins and preserves draft/public boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvca-admin-test-"));
  let server;
  try {
    for (const name of ["data", "scripts/admin", "scripts/i18n"])
      cpSync(new URL(name, root), join(dir, name), { recursive: true });
    mkdirSync(join(dir, "public/posters"), { recursive: true });
    writeFileSync(join(dir, "data/public/catalog.json"), "[]\n");
    // The empty fixture uses preview films, not selections from the live catalog.
    const fixtureEditorialPath = join(dir, "data/public/editorial.json");
    const fixtureEditorial = JSON.parse(readFileSync(fixtureEditorialPath));
    fixtureEditorial.selections = fixtureEditorial.selections.map(
      (selection) => ({ ...selection, filmSlugs: [] })
    );
    writeFileSync(
      fixtureEditorialPath,
      JSON.stringify(fixtureEditorial, null, 2) + "\n"
    );
    // Bind an ephemeral port, then recreate with its actual origin policy.
    server = createAdmin(dir, 0);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    server = createAdmin(dir, port);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${port}`;
    const state = await (await fetch(origin + "/api/state")).json();
    const post = (route, value, extra = {}) =>
      fetch(origin + "/api/" + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "X-PVCA-Token": state.token,
          ...extra,
        },
        body: JSON.stringify(value),
      });
    const initial = readFileSync(
      join(dir, "data/public/editorial.json"),
      "utf8"
    );
    for (const members of [["missing-film"], ["ikiru-1952", "ikiru-1952"]]) {
      const invalidSelection = structuredClone(state.editorial);
      invalidSelection.selections[0].filmSlugs = members;
      assert.equal((await post("editorial", invalidSelection)).status, 400);
      assert.equal(
        readFileSync(join(dir, "data/public/editorial.json"), "utf8"),
        initial
      );
    }
    assert.equal(
      (
        await post("editorial", state.editorial, {
          Origin: "https://example.org",
        })
      ).status,
      400
    );
    assert.equal(
      readFileSync(join(dir, "data/public/editorial.json"), "utf8"),
      initial
    );
    assert.equal(
      (await post("editorial", state.editorial, { "X-PVCA-Token": "wrong" }))
        .status,
      400
    );
    const invalidHost = await new Promise((resolve, reject) => {
      const req = request(
        origin + "/api/state",
        { headers: { Host: "example.org" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(invalidHost, 400);
    const config = structuredClone(state.editorial);
    config.featuredSlug = "ikiru-1952";
    config.featuredNote = "Synthetic test note";
    assert.equal((await post("editorial", config)).status, 200);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "data/public/editorial.json")))
        .featuredSlug,
      "ikiru-1952"
    );
    const film = {
      id: "fixture",
      slug: "fixture-2000",
      title: "Synthetic test film",
      year: 2000,
      directors: ["Test director"],
      countries: [],
      poster: "",
      catalog_copy_id: "copy",
      copies: [
        {
          id: "copy",
          resolution: "",
          size_gib: null,
          audio_languages: [],
          subtitle_languages: [],
        },
      ],
      external_links: [],
      selections: [],
      added_at: "2026-10-07",
    };
    assert.equal((await post("draft", film)).status, 200);
    assert.equal(
      readFileSync(join(dir, "data/public/catalog.json"), "utf8"),
      "[]\n"
    );
    assert.equal((await post("apply", film)).status, 400);
    assert.equal(
      readFileSync(join(dir, "data/public/catalog.json"), "utf8"),
      "[]\n"
    );
    const poster = await post("poster", {
      extension: "png",
      base64: Buffer.from("not an image").toString("base64"),
    });
    assert.equal(poster.status, 400);
    const uploaded = await post("poster", {
      extension: "png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=",
    });
    assert.equal(uploaded.status, 200);
    film.poster = (await uploaded.json()).poster;
    film.copies[0].resolution = "1080p";
    film.copies[0].size_gib = 12;
    assert.equal((await post("apply", film)).status, 200);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "data/public/catalog.json"))).length,
      1
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, ".local-admin/drafts.json"))).length,
      0
    );
    film.title = "Updated fixture";
    assert.equal((await post("apply", film)).status, 200);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "data/public/catalog.json"))).length,
      1
    );
    const actual = await (await fetch(origin + "/api/state")).json();
    actual.editorial.featuredSlug = film.slug;
    assert.equal((await post("editorial", actual.editorial)).status, 200);
    const beforeImport = readFileSync(
      join(dir, "data/public/catalog.json"),
      "utf8"
    );
    const bulk = await post("import/preview", {
      records: [{ ...film, id: "second", slug: "second-2000", tmdb_id: 22 }],
      enrich: false,
    });
    assert.equal(bulk.status, 200);
    const plan = await bulk.json();
    assert.equal(plan.summary.created, 1);
    assert.equal(
      readFileSync(join(dir, "data/public/catalog.json"), "utf8"),
      beforeImport
    );
    assert.equal(
      (await post("import/confirm", { planId: plan.planId })).status,
      200
    );
    const again = await (
      await post("import/preview", {
        records: [{ ...film, id: "second", slug: "second-2000", tmdb_id: 22 }],
        enrich: false,
      })
    ).json();
    assert.equal(again.summary.ignored, 1);
    assert.equal(
      (await post("import/confirm", { planId: again.planId })).status,
      200
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "data/public/catalog.json"))).length,
      2
    );
    const stale = await (
      await post("import/preview", { records: [film], enrich: false })
    ).json();
    film.title = "Another manual edit";
    assert.equal((await post("apply", film)).status, 200);
    assert.equal(
      (await post("import/confirm", { planId: stale.planId })).status,
      400
    );
    assert.equal((await fetch(origin + "/admin-i18n.mjs")).status, 200);
    assert.equal(
      (await fetch(origin + "/.local-admin/drafts.json")).status,
      404
    );
    assert.equal((await fetch(origin + "/admin/")).status, 404);
    assert.equal(readdirSync(join(dir, "public/posters")).length, 1);
    const canonical = {
      schema_version: "pvca-clean-catalog-6.1",
      item_count: 1,
      private_note: "PRIVATE" + "x".repeat(9 * 1024 * 1024),
      items: [
        {
          pvca_id: "PVCA-TEST",
          title: "Canonical fixture",
          year: 2000,
          identity: { tmdb: { id: 333 } },
          availability: { preferred_media_source: "ARCHIVE" },
          media: { source: "ARCHIVE" },
          metadata: { credits: { directors: ["Fixture director"] } },
          copies: {
            archive: {
              status: "AVAILABLE",
              size: { bytes: 1073741824 },
              resolution: { declared_class: "1080p" },
              embedded_subtitles: { tracks: [{ language: { tag: "por" } }] },
            },
          },
        },
      ],
    };
    const publicBeforeCanonical = readFileSync(
      join(dir, "data/public/catalog.json"),
      "utf8"
    );
    const canonicalResponse = await post("import/preview", {
      records: canonical,
      enrich: false,
      portugueseIsBrazilian: true,
    });
    assert.equal(canonicalResponse.status, 200);
    const canonicalPlan = await canonicalResponse.json();
    assert.equal(canonicalPlan.canonical, true);
    assert.equal(canonicalPlan.summary.created, 1);
    assert.equal(canonicalPlan.readiness.pending, 1);
    assert.ok(!JSON.stringify(canonicalPlan).includes("PRIVATE"));
    assert.equal(
      readFileSync(join(dir, "data/public/catalog.json"), "utf8"),
      publicBeforeCanonical
    );
    assert.equal(
      (await post("import/confirm", { planId: canonicalPlan.planId })).status,
      200
    );
    assert.equal(
      readFileSync(join(dir, "data/public/catalog.json"), "utf8"),
      publicBeforeCanonical
    );
  } finally {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Letterboxd export returns the whole current catalog and its row count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvca-admin-export-"));
  let server;
  try {
    for (const name of ["data", "scripts/admin", "scripts/i18n"])
      cpSync(new URL(name, root), join(dir, name), { recursive: true });
    const catalog = JSON.parse(
      readFileSync(join(dir, "data/public/catalog.json"))
    );
    // The export reads the published catalog, not the working copy: the stub has one film more.
    const published = async () => ({
      films: [...catalog, { ...catalog[0], tmdb_id: 1 }],
      uris: { 1: "https://letterboxd.com/film/x/" },
    });
    server = createAdmin(dir, 0, published);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    server = createAdmin(dir, port, published);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${port}`;
    const { token } = await (await fetch(origin + "/api/state")).json();
    const result = await (
      await fetch(origin + "/api/export/letterboxd", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "X-PVCA-Token": token,
        },
        body: "{}",
      })
    ).json();
    const lines = result.csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "﻿LetterboxdURI,tmdbID,Review");
    assert.equal(result.count, catalog.length + 1);
    assert.equal(lines.length - 1, result.count);
    assert.match(result.filename, new RegExp(`— ${result.count} títulos — `));
    assert.match(lines.at(-1), /^https:\/\/letterboxd\.com\/film\/x\/,1,/);
    assert.doesNotMatch(result.csv, /em envio/);
  } finally {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Letterboxd export fails with no CSV when the published data cannot be read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvca-admin-export-fail-"));
  let server;
  try {
    for (const name of ["data", "scripts/admin", "scripts/i18n"])
      cpSync(new URL(name, root), join(dir, name), { recursive: true });
    const unreachable = async () => {
      throw new Error("sem rede");
    };
    server = createAdmin(dir, 0, unreachable);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    server = createAdmin(dir, port, unreachable);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${port}`;
    const { token } = await (await fetch(origin + "/api/state")).json();
    const response = await fetch(origin + "/api/export/letterboxd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-PVCA-Token": token,
      },
      body: "{}",
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.error, /sem rede/);
    assert.equal(result.csv, undefined);
  } finally {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
