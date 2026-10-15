import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmin } from "./admin.mjs";
const root = new URL("../", import.meta.url);
test("film removal is identity checked, recoverable, and reconciles editorial references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pvca-admin-lifecycle-"));
  let server;
  try {
    cpSync(new URL("data", root), join(dir, "data"), { recursive: true });
    const film = JSON.parse(
      readFileSync(join(dir, "data/public/catalog.json"))
    )[0];
    const config = JSON.parse(
      readFileSync(join(dir, "data/public/editorial.json"))
    );
    config.featuredSlug = film.slug;
    config.featuredNote = "Keep this feature note";
    config.selections = [
      {
        id: "test",
        title: "Test selection",
        description: "Test",
        rule: "manual",
        filmSlugs: [film.slug],
      },
    ];
    config.homeSelectionIds = ["test"];
    film.selections = ["Test selection"];
    writeFileSync(
      join(dir, "data/public/catalog.json"),
      JSON.stringify([film])
    );
    writeFileSync(
      join(dir, "data/public/editorial.json"),
      JSON.stringify(config)
    );
    mkdirSync(join(dir, "public/posters"), { recursive: true });
    writeFileSync(join(dir, "public", film.poster), "poster stays");
    server = createAdmin(dir, 0);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    server = createAdmin(dir, port);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${port}`;
    const state = () => fetch(origin + "/api/state").then((r) => r.json());
    const initial = await state();
    const post = (route, data, token = initial.token, extraHeaders = {}) =>
      fetch(origin + "/api/" + route, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-PVCA-Token": token,
          ...extraHeaders,
        },
        body: JSON.stringify(data),
      });
    assert.equal((await fetch(origin + film.poster)).status, 200);
    assert.equal(
      (await fetch(origin + "/posters/%2e%2e%2f.local-admin%2fdatabase.json"))
        .status,
      404
    );
    assert.equal(
      (
        await post(
          "film/delete",
          { id: film.id, slug: film.slug, expected: film },
          "wrong"
        )
      ).status,
      400
    );
    assert.equal(
      (
        await post("film/delete", {
          id: film.id,
          slug: "wrong",
          expected: film,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await post("film/delete", {
          id: film.id,
          slug: film.slug,
          expected: { ...film, title: "stale" },
        })
      ).status,
      400
    );
    assert.equal((await state()).catalog.length, 1);
    assert.equal(
      (
        await post("film/delete", {
          id: film.id,
          slug: film.slug,
          expected: film,
        })
      ).status,
      200
    );
    const deleted = await state();
    assert.equal(deleted.catalog.length, 0);
    assert.equal(deleted.films.length, 0);
    assert.equal(deleted.preview, false);
    assert.equal(deleted.editorial.featuredSlug, null);
    assert.deepEqual(deleted.editorial.selections[0].filmSlugs, []);
    assert.equal(deleted.deletedFilms.length, 1);
    assert.equal(deleted.deletedFilms[0].id, film.id);
    assert.equal(
      readFileSync(join(dir, "public", film.poster), "utf8"),
      "poster stays"
    );
    assert.ok(readdirSync(join(dir, ".local-admin/backups")).length);
    assert.equal(
      (
        await post("film/delete", {
          id: film.id,
          slug: film.slug,
          expected: film,
        })
      ).status,
      400
    );
    assert.equal(
      (await post("film/restore", { id: film.id, slug: film.slug })).status,
      200
    );
    const restored = await state();
    assert.equal(restored.catalog.length, 1);
    assert.equal(restored.catalog[0].id, film.id);
    assert.equal(restored.editorial.featuredSlug, film.slug);
    assert.deepEqual(restored.editorial.selections[0].filmSlugs, [film.slug]);
    assert.equal(restored.deletedFilms.length, 0);
    // Existing selection CRUD must reconcile public membership without removing films.
    const edit = restored.editorial;
    edit.selections[0].title = "Renamed";
    assert.equal((await post("editorial", edit)).status, 200);
    assert.deepEqual((await state()).catalog[0].selections, ["Renamed"]);
    edit.selections.push({
      id: "new-selection",
      title: "New selection",
      description: "",
      rule: "manual",
      filmSlugs: [film.slug],
    });
    assert.equal((await post("editorial", edit)).status, 200);
    assert.equal(
      (
        await post("editorial", edit, initial.token, {
          "X-PVCA-Editorial": initial.editorialVersion,
        })
      ).status,
      400
    );
    const afterCreate = await state();
    assert.equal(afterCreate.editorial.selections.length, 2);
    const remove = afterCreate.editorial;
    remove.selections = [];
    remove.homeSelectionIds = [];
    assert.equal((await post("editorial", remove)).status, 200);
    const final = await state();
    assert.equal(final.catalog.length, 1);
    assert.deepEqual(final.catalog[0].selections, []);
    assert.equal(final.editorial.selections.length, 0);
    const draft = structuredClone(film);
    draft.id = "PVCA-999999";
    draft.slug = "draft-lifecycle";
    delete draft.tmdb_id;
    assert.equal((await post("draft", draft)).status, 200);
    const savedDraft = (await state()).drafts.find((f) => f.id === draft.id);
    assert.equal(
      (
        await post("film/delete", {
          id: savedDraft.id,
          slug: savedDraft.slug,
          expected: savedDraft,
        })
      ).status,
      200
    );
    assert.equal((await state()).drafts.length, 0);
    assert.equal(
      (await post("film/restore", { id: draft.id, slug: draft.slug })).status,
      200
    );
    assert.equal((await state()).drafts.length, 1);
    assert.equal((await state()).catalog.length, 1);
    // Simulate an interrupted admin commit: the journal must recover all linked files.
    const backups = readdirSync(join(dir, ".local-admin/backups")).filter(
      (name) => name.startsWith("admin-")
    );
    const bundle = JSON.parse(
      readFileSync(join(dir, ".local-admin/backups", backups.at(-1)))
    );
    writeFileSync(
      join(dir, ".local-admin/transaction.json"),
      JSON.stringify(bundle)
    );
    const recovered = await state();
    assert.equal(
      recovered.editorial.selections.length,
      bundle.editorial.selections.length
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, ".local-admin/database.json"))),
      bundle.database
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, ".local-admin/drafts.json"))),
      bundle.drafts
    );
  } finally {
    if (server?.listening) await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
