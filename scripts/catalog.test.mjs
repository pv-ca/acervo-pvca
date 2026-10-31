import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateCatalog,
  toRuntimeFilm,
  mergeCatalog,
} from "./lib/catalog.mjs";
import { languagePath, routePath } from "./i18n/public.mjs";

const root = new URL("../", import.meta.url);
const schema = JSON.parse(
  readFileSync(new URL("data/schema/public-catalog.schema.json", root), "utf8")
);
const temp = mkdtempSync(join(tmpdir(), "pvca-catalog-test-"));
mkdirSync(join(temp, "public/posters"), { recursive: true });
// Synthetic test asset and records exist only in the isolated test directory.
writeFileSync(
  join(temp, "public/posters/fixture.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=",
    "base64"
  )
);
const fixture = () => ({
  id: "fixture",
  slug: "fixture-2000",
  title: "Test fixture",
  year: 2000,
  directors: ["Director A", "Director B"],
  countries: ["Country A"],
  poster: "/posters/fixture.png",
  catalog_copy_id: "selected",
  copies: [
    {
      id: "higher",
      resolution: "2160p",
      size_gib: 30,
      audio_languages: [],
      subtitle_languages: [],
    },
    {
      id: "selected",
      resolution: "1080p",
      size_gib: 15.123,
      format: "MKV",
      audio_languages: ["Japonês"],
      subtitle_languages: ["Português (Brasil)"],
    },
  ],
  external_links: [
    {
      provider: "internet_archive",
      url: "https://archive.org/details/fixture",
      copy_id: "selected",
    },
  ],
  selections: ["Selection fixture"],
});
const validate = (value) =>
  validateCatalog(value, schema, join(temp, "public"));

test("language navigation preserves the GitHub Pages base without duplicating it", () => {
  assert.equal(
    languagePath("en", "/acervo-pvca/filmes/fixture-2000/", "/acervo-pvca/"),
    "/acervo-pvca/en/filmes/fixture-2000/"
  );
  assert.equal(
    languagePath(
      "pt-BR",
      "/acervo-pvca/en/filmes/fixture-2000/",
      "/acervo-pvca/"
    ),
    "/acervo-pvca/filmes/fixture-2000/"
  );
  assert.equal(
    languagePath("en", "/filmes/", "/acervo-pvca/"),
    "/acervo-pvca/en/filmes/"
  );
  assert.equal(languagePath("en", "/en/filmes/"), "/en/filmes/");
  assert.equal(
    routePath("/acervo-pvca-extra/", "/acervo-pvca/"),
    "/acervo-pvca-extra/"
  );
});

test("accepts a complete projection and maps the explicitly chosen copy", () => {
  const film = fixture();
  assert.deepEqual(validate([film]), []);
  const mapped = toRuntimeFilm(film);
  assert.equal(mapped.catalogCopyId, "selected");
  assert.equal(
    mapped.copies.find((copy) => copy.id === mapped.catalogCopyId).resolution,
    "1080p"
  );
  assert.equal(mapped.director, "Director A, Director B");
  assert.equal(mapped.externalLinks[0].provider, "Internet Archive");
  assert.equal(mapped.copies[1].sizeGiB, 15.123);
  assert.equal(mapped.copies[1].format, "MKV");
});
test("rejects missing fields, nonpositive sizes, wrong types and unknown private fields", () => {
  for (const change of [
    (film) => delete film.poster,
    (film) => (film.copies[1].size_gib = 0),
    (film) => (film.copies[1].size_gib = "15,1"),
    (film) => (film.local_path = "PRIVATE"),
    (film) => (film.copies[1].hash = "PRIVATE"),
  ]) {
    const film = fixture();
    change(film);
    const errors = validate([film]);
    assert.ok(errors.length);
    assert.ok(!errors.join("\n").includes("PRIVATE"));
  }
});
test("rejects missing posters, path traversal and external image URLs", () => {
  for (const poster of [
    "/posters/missing.png",
    "/posters/../fixture.png",
    "https://example.org/poster.jpg",
  ]) {
    const film = fixture();
    film.poster = poster;
    assert.ok(validate([film]).length);
  }
});
test("rejects duplicates and broken film/copy references", () => {
  assert.ok(validate([fixture(), fixture()]).length);
  const film = fixture();
  film.catalog_copy_id = "unknown";
  assert.ok(validate([film]).length);
  film.catalog_copy_id = "selected";
  film.external_links[0].copy_id = "unknown";
  assert.ok(validate([film]).length);
  film.external_links = [];
  film.copies.push({ ...film.copies[0] });
  assert.ok(validate([film]).length);
});
test("rejects malformed, insecure, mismatched and credential-bearing URLs", () => {
  for (const url of [
    "not a URL",
    "http://archive.org/details/fixture",
    "https://user:password@archive.org/",
    "https://example.org/",
    "https://archive.org/?access_token=PRIVATE",
  ]) {
    const film = fixture();
    film.external_links[0].url = url;
    assert.ok(validate([film]).length);
  }
  const film = fixture();
  film.external_links = [
    {
      provider: "google_drive",
      url: "https://drive.google.com/file/d/fixture/view",
    },
  ];
  assert.deepEqual(validate([film]), []);
  film.external_links = [];
  assert.deepEqual(validate([film]), []);
  film.external_links = [{ provider: null, url: "https://archive.org/" }];
  assert.ok(validate([film]).length);
});
test("merges additions, requires explicit replacement, rejects identity conflicts", () => {
  const existing = fixture(),
    incoming = { ...fixture(), title: "Updated fixture" };
  assert.throws(() => mergeCatalog([existing], [incoming]));
  assert.equal(
    mergeCatalog([existing], [incoming], true)[0].title,
    "Updated fixture"
  );
  assert.throws(() =>
    mergeCatalog([existing], [{ ...incoming, id: "different" }], true)
  );
  assert.equal(
    mergeCatalog([existing], [{ ...incoming, id: "new", slug: "new-2000" }])
      .length,
    2
  );
  assert.equal(existing.title, "Test fixture");
});
test("CLI check does not write; rejected imports preserve the existing catalog", () => {
  mkdirSync(join(temp, "data/schema"), { recursive: true });
  mkdirSync(join(temp, "data/public"), { recursive: true });
  cpSync(new URL("scripts", root), join(temp, "scripts"), { recursive: true });
  // The catalog writer formats with the repository's own Prettier.
  symlinkSync(new URL("node_modules", root), join(temp, "node_modules"));
  writeFileSync(
    join(temp, "data/schema/public-catalog.schema.json"),
    JSON.stringify(schema)
  );
  const target = join(temp, "data/public/catalog.json");
  writeFileSync(target, "[]\n");
  const input = join(temp, "input.json");
  writeFileSync(input, JSON.stringify([fixture()]));
  const run = (...args) =>
    spawnSync(process.execPath, [join(temp, "scripts/catalog.mjs"), ...args], {
      encoding: "utf8",
    });
  assert.equal(run("check", input).status, 0);
  assert.equal(readFileSync(target, "utf8"), "[]\n");
  assert.equal(run("import", input).status, 0);
  const preserved = readFileSync(target, "utf8");
  assert.equal(run("import", input).status, 1);
  assert.equal(readFileSync(target, "utf8"), preserved);
  const updated = fixture();
  updated.title = "Updated fixture";
  writeFileSync(input, JSON.stringify([updated]));
  assert.equal(run("import", input, "--replace").status, 0);
  const latest = readFileSync(target, "utf8");
  writeFileSync(input, '[{"secret":"PRIVATE",]');
  const invalid = run("import", input);
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes("PRIVATE"));
  assert.equal(readFileSync(target, "utf8"), latest);
});
test("a real projection drives static pages without preview films or invented editorial entries", () => {
  const site = join(temp, "site");
  mkdirSync(site, { recursive: true });
  for (const path of [
    "src",
    "data/schema",
    "public",
    "astro.config.mjs",
    "package.json",
    "tsconfig.json",
  ])
    cpSync(new URL(path, root), join(site, path), { recursive: true });
  mkdirSync(join(site, "scripts/lib"), { recursive: true });
  cpSync(new URL("scripts/lib", root), join(site, "scripts/lib"), {
    recursive: true,
  });
  cpSync(new URL("scripts/i18n", root), join(site, "scripts/i18n"), {
    recursive: true,
  });
  symlinkSync(
    new URL("node_modules", root).pathname,
    join(site, "node_modules"),
    "dir"
  );
  mkdirSync(join(site, "data/public"), { recursive: true });
  const editorial = JSON.parse(
    readFileSync(new URL("data/public/editorial.json", root), "utf8")
  );
  // This isolated build contains one fixture, not the live catalog's members.
  editorial.selections = editorial.selections.map((selection) => ({
    ...selection,
    filmSlugs: [],
  }));
  editorial.selections.push({
    id: "selection-fixture",
    title: "Selection fixture",
    description: "",
    rule: "manual",
    filmSlugs: ["fixture-2000"],
  });
  cpSync(
    new URL("data/public/catalog.preview.json", root),
    join(site, "data/public/catalog.preview.json")
  );
  writeFileSync(
    join(site, "data/public/editorial.json"),
    JSON.stringify(editorial)
  );
  const film = fixture();
  film.external_links = [];
  film.translations = {
    "pt-BR": { title: "Test fixture", synopsis: "Descrição teste" },
    en: { title: "English fixture", synopsis: "English synopsis" },
  };
  writeFileSync(join(site, "data/public/catalog.json"), JSON.stringify([film]));
  writeFileSync(join(site, "data/letterboxd-uris.json"), "{}");
  cpSync(
    join(temp, "public/posters/fixture.png"),
    join(site, "public/posters/fixture.png")
  );
  const astroPackage = JSON.parse(
    readFileSync(new URL("node_modules/astro/package.json", root), "utf8")
  );
  const built = spawnSync(
    process.execPath,
    [
      new URL(`node_modules/astro/${astroPackage.bin.astro}`, root).pathname,
      "build",
    ],
    { cwd: site, encoding: "utf8", timeout: 60000 }
  );
  assert.equal(built.status, 0, built.stdout + "\n" + built.stderr);
  assert.ok(existsSync(join(site, "dist/filmes/fixture-2000/index.html")));
  // The admin's Letterboxd export reads this file: films and uris are its contract.
  const exported = JSON.parse(
    readFileSync(join(site, "dist/letterboxd.json"), "utf8")
  );
  assert.ok(Array.isArray(exported.films) && typeof exported.uris === "object");
  assert.ok(!existsSync(join(site, "dist/filmes/tokyo-story-1953/index.html")));
  const catalog = readFileSync(
    join(site, "dist/filmes/index.html"),
    "utf8"
  ).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  assert.ok(catalog.includes("Test fixture"));
  assert.ok(catalog.includes("15,1 GiB"));
  assert.ok(!catalog.includes("nesta prévia"));
  const detail = readFileSync(
    join(site, "dist/filmes/fixture-2000/index.html"),
    "utf8"
  );
  assert.ok(detail.includes("Selection fixture"));
  assert.ok(!detail.includes("Não há acesso público"));
  const home = readFileSync(join(site, "dist/index.html"), "utf8");
  assert.ok(!home.includes("undefined"));
  assert.ok(!home.includes("Ver ficha →"));
  assert.ok(!existsSync(join(site, "dist/admin")));
  assert.ok(!home.includes("Painel local"));
  const english = readFileSync(
    join(site, "dist/en/filmes/fixture-2000/index.html"),
    "utf8"
  );
  assert.ok(english.includes("English fixture"));
  assert.ok(english.includes("English synopsis"));
  assert.ok(english.includes('lang="en"'));
  const englishCatalog = readFileSync(
    join(site, "dist/en/filmes/index.html"),
    "utf8"
  );
  assert.ok(englishCatalog.includes('data-ptbr="true"'));
  assert.ok(englishCatalog.includes("/en/filmes/fixture-2000/"));
  const selectionIndex = readFileSync(
    join(site, "dist/selecoes/index.html"),
    "utf8"
  );
  assert.ok(selectionIndex.includes('href="/selecoes/selection-fixture/"'));
  assert.ok(!selectionIndex.includes('href="/filmes/fixture-2000/"'));
  const selectionPage = readFileSync(
    join(site, "dist/selecoes/selection-fixture/index.html"),
    "utf8"
  );
  assert.ok(selectionPage.includes('id="filmSearch"'));
  assert.ok(selectionPage.includes('class="film-card"'));
  assert.ok(selectionPage.includes('href="/filmes/fixture-2000/"'));
  const englishSelection = readFileSync(
    join(site, "dist/en/selecoes/selection-fixture/index.html"),
    "utf8"
  );
  assert.ok(englishSelection.includes("English fixture"));
  assert.ok(englishSelection.includes('lang="en"'));

  const pagesBuilt = spawnSync(
    process.execPath,
    [
      new URL(`node_modules/astro/${astroPackage.bin.astro}`, root).pathname,
      "build",
      "--site",
      "https://pv-ca.github.io",
      "--base",
      "/acervo-pvca",
    ],
    { cwd: site, encoding: "utf8", timeout: 60000 }
  );
  assert.equal(
    pagesBuilt.status,
    0,
    pagesBuilt.stdout + "\n" + pagesBuilt.stderr
  );
  const deployed = readFileSync(
    join(site, "dist/en/filmes/fixture-2000/index.html"),
    "utf8"
  );
  assert.ok(deployed.includes('lang="en"'));
  assert.ok(deployed.includes("/acervo-pvca/posters/fixture.png"));
  assert.ok(deployed.includes('href="/acervo-pvca/filmes/fixture-2000/"'));
  assert.ok(deployed.includes('href="/acervo-pvca/en/filmes/"'));
  assert.ok(
    deployed.includes('href="/acervo-pvca/en/selecoes/selection-fixture/"')
  );
});
test.after(() => rmSync(temp, { recursive: true, force: true }));
