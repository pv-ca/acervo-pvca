import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { letterboxdCsv, letterboxdFilename } from "./lib/letterboxd.mjs";
import {
  validateCatalog,
  mergeCatalog,
  toRuntimeFilm,
  validateLink,
} from "./lib/catalog.mjs";
import { validateEditorial } from "./lib/editorial.mjs";
import { saveManual, allRecords, planImport } from "./lib/database.mjs";
import { enrichTmdb, tmdbStatus } from "./lib/tmdb.mjs";
import {
  isCanonical,
  convertCanonical,
  mergeEnrichment,
} from "./lib/canonical.mjs";

import { readDatabase, updateDatabase, fingerprint } from "./lib/store.mjs";

export function createAdmin(root, port = 4323) {
  const token = randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  const path = (name) => resolve(root, name);
  const read = (name) => JSON.parse(readFileSync(path(name), "utf8"));
  const save = (name, value) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    if (name.startsWith("data/public/") && existsSync(path(name))) {
      mkdirSync(path(".local-admin/backups"), { recursive: true });
      writeFileSync(
        path(
          `.local-admin/backups/${Date.now()}-${randomBytes(4).toString("hex")}-${name.split("/").pop()}`
        ),
        readFileSync(path(name)),
        { flag: "wx" }
      );
    }
    const temporary = path(name) + ".tmp";
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
    renameSync(temporary, path(name));
  };
  let building = false;
  const plans = new Map();
  let importing = false;
  const schema = read("data/schema/public-catalog.schema.json");
  const drafts = () =>
    existsSync(path(".local-admin/drafts.json"))
      ? read(".local-admin/drafts.json")
      : [];
  const database = () => readDatabase(root);
  const commitDatabase = (db, expected) =>
    updateDatabase(root, () => db, expected);
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const draftKeys = Object.keys(schema.items.properties);
  function validateDraft(film) {
    assert(
      film && typeof film === "object" && !Array.isArray(film),
      "Filme inválido."
    );
    assert(
      Object.keys(film).every((key) => draftKeys.includes(key)),
      "Campo fora do cadastro público."
    );
    assert(
      typeof film.id === "string" &&
        film.id.trim() &&
        typeof film.slug === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(film.slug),
      "Preencha título e endereço do filme."
    );
    assert(
      Array.isArray(film.copies) && Array.isArray(film.external_links),
      "Cópias e links inválidos."
    );
    for (const copy of film.copies)
      assert(
        copy &&
          typeof copy === "object" &&
          Object.keys(copy).every(
            (key) => key in schema.items.properties.copies.items.properties
          ),
        "Campo de cópia fora do cadastro público."
      );
    for (const link of film.external_links)
      assert(
        link &&
          typeof link === "object" &&
          Object.keys(link).every(
            (key) =>
              key in schema.items.properties.external_links.items.properties
          ),
        "Campo de link fora do cadastro público."
      );
    for (const link of film.external_links) {
      const error = validateLink(link);
      assert(!error, error);
    }
  }
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      assert(
        req.headers.host === `127.0.0.1:${port}`,
        "Endereço local inválido."
      );
      const pathname = new URL(req.url, origin).pathname;
      if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(readFileSync(path("scripts/admin/index.html"), "utf8"));
        return;
      }
      if (
        req.method === "GET" &&
        ["/app.js", "/style.css", "/admin-i18n.mjs", "/public.mjs"].includes(
          pathname
        )
      ) {
        res.writeHead(200, {
          "Content-Type": pathname.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          readFileSync(
            path(
              pathname === "/admin-i18n.mjs"
                ? "scripts/i18n/admin.mjs"
                : pathname === "/public.mjs"
                  ? "scripts/i18n/public.mjs"
                  : "scripts/admin" + pathname
            )
          )
        );
        return;
      }
      if (req.method === "GET" && pathname === "/api/state") {
        assert(
          !req.headers.origin || req.headers.origin === origin,
          "Origem inválida."
        );
        const catalog = read("data/public/catalog.json");
        const db = database();
        const pending = Object.values(db.films)
          .filter((row) => !row.published)
          .map((row) => allRecords({ ...db, films: { row } })[0]);
        const editorial = read("data/public/editorial.json");
        if (catalog.length) {
          const slugs = new Set(catalog.map((f) => f.slug));
          if (!slugs.has(editorial.featuredSlug)) editorial.featuredSlug = null;
          editorial.selections = editorial.selections.map((s) => ({
            ...s,
            filmSlugs: s.filmSlugs.filter((slug) => slugs.has(slug)),
          }));
        }
        json(200, {
          token,
          editorial,
          catalog,
          drafts: [
            ...pending,
            ...drafts().filter((f) => !pending.some((row) => row.id === f.id)),
          ],
          preview: catalog.length === 0,
          films: catalog.length
            ? catalog.map(toRuntimeFilm)
            : read("data/public/catalog.preview.json"),
          entities: db.entities,
        });
        return;
      }
      if (req.method !== "POST" || !pathname.startsWith("/api/")) {
        json(404, { error: "Página inexistente." });
        return;
      }
      assert(
        req.headers.origin === origin && req.headers["x-pvca-token"] === token,
        "Abra o painel local para salvar."
      );
      assert(
        req.headers["content-type"] === "application/json",
        "Formato de pedido inválido."
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        const limit = pathname === "/api/import/preview" ? 32 : 8;
        assert(
          size <= limit * 1024 * 1024,
          `Arquivo muito grande (limite ${limit} MiB).`
        );
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert(!building, "Aguarde a geração da prévia terminar.");
      assert(!importing, "Aguarde a validação da importação terminar.");
      if (pathname === "/api/import/preview") {
        importing = true;
        try {
          const conversion = isCanonical(data.records)
            ? convertCanonical(data.records, {
                portugueseIsBrazilian: data.portugueseIsBrazilian === true,
              })
            : null;
          if (conversion) data.records = conversion.records;
          assert(
            Array.isArray(data.records) && data.records.length <= 10000,
            "O JSON deve conter uma lista de até 10.000 filmes."
          );
          const db = database(),
            records = [],
            sourceIndices = [],
            failures = conversion?.failures ?? [];
          for (let index = 0; index < data.records.length; index++) {
            const record = data.records[index];
            if (data.enrich && record?.tmdb_id) {
              try {
                const enriched = await enrichTmdb(root, record.tmdb_id);
                records.push(mergeEnrichment(record, enriched));
                sourceIndices.push(conversion?.indices[index] ?? index);
              } catch (error) {
                failures.push({
                  index: conversion?.indices[index] ?? index,
                  status: "rejected",
                  title: record.title ?? `TMDB #${record.tmdb_id}`,
                  reasons: [error.message],
                  protected: [],
                });
              }
            } else {
              records.push(record);
              sourceIndices.push(conversion?.indices[index] ?? index);
            }
          }
          const plan = planImport(db, records, schema, path("public"));
          plan.items.forEach(
            (item) => (item.index = sourceIndices[item.index])
          );
          plan.items.push(...failures);
          plan.items.sort((a, b) => a.index - b.index);
          plan.summary.rejected += failures.length;
          const id = randomBytes(24).toString("hex");
          plans.clear();
          plans.set(id, {
            ...plan,
            expires: Date.now() + 10 * 60 * 1000,
            fingerprint: JSON.stringify(db),
          });
          json(200, {
            planId: id,
            items: plan.items,
            summary: plan.summary,
            readiness: {
              ready: plan.items.filter((i) => i.publicReady).length,
              pending: plan.items.filter((i) => i.publicReady === false).length,
            },
            canonical: !!conversion,
          });
          return;
        } finally {
          importing = false;
        }
      }
      if (pathname === "/api/import/confirm") {
        const plan = plans.get(data.planId);
        assert(
          plan && plan.expires > Date.now(),
          "Prévia expirada. Valide o JSON novamente."
        );
        assert(
          JSON.stringify(database()) === plan.fingerprint,
          "O catálogo mudou. Valide o JSON novamente."
        );
        commitDatabase(plan.database, plan.fingerprint);
        plans.delete(data.planId);
        json(200, {
          summary: plan.summary,
          message: "Importação concluída localmente.",
        });
        return;
      }
      if (pathname === "/api/tmdb/status") {
        try {
          json(200, await tmdbStatus(root));
        } catch (error) {
          json(200, { available: false, error: error.message });
        }
        return;
      }
      if (pathname === "/api/editorial") {
        const errors = validateEditorial(data);
        assert(!errors.length, errors.join("\n"));
        const catalog = read("data/public/catalog.json");
        const films = catalog.length
          ? catalog
          : read("data/public/catalog.preview.json");
        const referenceErrors = validateEditorial(data, films);
        assert(!referenceErrors.length, referenceErrors.join("\n"));
        assert(
          !data.featuredSlug || films.some((f) => f.slug === data.featuredSlug),
          "Filme em destaque inexistente."
        );
        assert(
          data.selections.every((s) =>
            s.filmSlugs.every((slug) => films.some((f) => f.slug === slug))
          ),
          "Filme de seleção inexistente."
        );
        const old = read("data/public/editorial.json");
        const oldTitles = new Set(old.selections.map((s) => s.title));
        const updated = catalog.map((film) => ({
          ...film,
          selections: [
            ...new Set([
              ...(film.selections ?? []).filter(
                (title) => !oldTitles.has(title)
              ),
              ...data.selections
                .filter(
                  (s) => s.rule === "manual" && s.filmSlugs.includes(film.slug)
                )
                .map((s) => s.title),
            ]),
          ],
        }));
        save("data/public/editorial.json", data);
        const changed = updated.filter(
          (film, index) =>
            JSON.stringify(film.selections) !==
            JSON.stringify(catalog[index].selections)
        );
        if (changed.length) {
          updateDatabase(root, (db) => {
            for (const film of changed) db = saveManual(db, film, true);
            return db;
          });
        }
      } else if (pathname === "/api/draft") {
        validateDraft(data);
        const records = drafts();
        const duplicate = records.find(
          (f) => f.id === data.id || f.slug === data.slug
        );
        assert(
          !duplicate ||
            (duplicate.id === data.id && duplicate.slug === data.slug),
          "Endereço ou identificador em uso."
        );
        save(".local-admin/drafts.json", [
          ...records.filter((f) => f.id !== data.id),
          data,
        ]);
        const db = database();
        const existing = Object.values(db.films).find(
          (row) => row.fields.id === data.id
        );
        if (!existing?.published)
          updateDatabase(
            root,
            (current) => saveManual(current, data, false),
            fingerprint(db)
          );
      } else if (pathname === "/api/apply") {
        validateDraft(data);
        const errors = validateCatalog([data], schema, path("public"));
        assert(!errors.length, errors.join("\n"));
        const catalog = mergeCatalog(
          read("data/public/catalog.json"),
          [data],
          true
        );
        const mergedErrors = validateCatalog(catalog, schema, path("public"));
        assert(!mergedErrors.length, mergedErrors.join("\n"));
        updateDatabase(root, (current) => saveManual(current, data, true));
        save(
          ".local-admin/drafts.json",
          drafts().filter((f) => f.id !== data.id)
        );
      } else if (pathname === "/api/poster") {
        assert(
          typeof data.base64 === "string" &&
            ["png", "jpg", "jpeg", "webp", "avif"].includes(data.extension),
          "Formato de pôster inválido."
        );
        const bytes = Buffer.from(data.base64, "base64");
        assert(
          bytes.length > 0 && bytes.length <= 5 * 1024 * 1024,
          "Pôster deve ter até 5 MiB."
        );
        const png = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpg = bytes[0] === 255 && bytes[1] === 216;
        const webp =
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
        const avif =
          bytes.toString("ascii", 4, 8) === "ftyp" &&
          /avif|avis/.test(bytes.toString("ascii", 8, 32));
        assert(
          (data.extension === "png" && png) ||
            (["jpg", "jpeg"].includes(data.extension) && jpg) ||
            (data.extension === "webp" && webp) ||
            (data.extension === "avif" && avif),
          "Arquivo não corresponde ao formato da imagem."
        );
        const filename = `poster-${randomBytes(12).toString("hex")}.${data.extension}`;
        mkdirSync(path("public/posters"), { recursive: true });
        writeFileSync(path("public/posters/" + filename), bytes, {
          flag: "wx",
        });
        json(200, { poster: "/posters/" + filename });
        return;
      } else if (pathname === "/api/export/letterboxd") {
        const { csv, count } = letterboxdCsv(
          read("data/public/catalog.json"),
          read("data/letterboxd-uris.json")
        );
        json(200, { csv, filename: letterboxdFilename(count), count });
        return;
      } else if (pathname === "/api/build") {
        building = true;
        const child = spawn(
          process.execPath,
          [path("node_modules/astro/bin/astro.mjs"), "build"],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
        );
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", () => {
          building = false;
          json(500, { error: "Não foi possível gerar a prévia." });
        });
        child.on("close", (code) => {
          building = false;
          json(
            code === 0 ? 200 : 422,
            code === 0
              ? { message: "Prévia gerada. Abra o site para conferir." }
              : {
                  error:
                    "A prévia não pôde ser gerada. Confira os dados e o terminal.",
                  details: output.slice(-4000),
                }
          );
        });
        return;
      } else {
        json(404, { error: "Operação inexistente." });
        return;
      }
      json(200, { message: "Alterações salvas localmente." });
    } catch (error) {
      json(400, {
        error:
          error instanceof SyntaxError ? "Pedido inválido." : error.message,
      });
    }
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const port = 4323;
  createAdmin(root, port).listen(port, "127.0.0.1", () =>
    console.log(
      `Painel privado local: http://127.0.0.1:${port}/\nNenhuma publicação ou upload de filmes é feito por este painel.`
    )
  );
}
