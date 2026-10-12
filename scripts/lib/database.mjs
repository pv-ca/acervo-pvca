import { createHash } from "node:crypto";
import { checkSchema, validateCatalog, validateLink } from "./catalog.mjs";

export const emptyDatabase = () => ({
  version: 1,
  revision: 0,
  films: {},
  entities: { directors: {}, countries: {}, genres: {}, languages: {} },
});
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
const stable = (value) => JSON.stringify(value);
const relationFields = {
  directors: "directors",
  countries: "countries",
  genres: "genres",
  original_languages: "languages",
};
const normalize = (value) =>
  value.trim().normalize("NFC").toLocaleLowerCase("en");

function entity(db, kind, value, reference) {
  const table = db.entities[kind];
  const key = reference?.id
    ? `${kind}:${reference.id}`
    : `${kind}:name:${hash(normalize(value))}`;
  if (!table[key])
    table[key] = {
      id: key,
      name: value,
      externalId: reference?.id ?? null,
      labels: reference?.labels ?? {},
    };
  else if (reference?.labels)
    table[key].labels = { ...table[key].labels, ...reference.labels };
  return key;
}
function normalizeFilm(db, record, previous, refs = {}) {
  const fields = structuredClone(record),
    relations = {};
  for (const [field, kind] of Object.entries(relationFields)) {
    relations[field] = (record[field] ?? []).map((value, index) => {
      const previousId = previous?.relations[field]?.find(
        (id) => db.entities[kind][id]?.name === value
      );
      return !refs[field]?.[index] && previousId
        ? previousId
        : entity(db, kind, value, refs[field]?.[index]);
    });
    delete fields[field];
  }
  // Copy languages share the language registry, too; arrays are export projections.
  const copyLanguages = {};
  for (const copy of record.copies ?? [])
    copyLanguages[copy.id] = {
      audio: (copy.audio_languages ?? []).map((name) =>
        entity(db, "languages", name)
      ),
      subtitles: (copy.subtitle_languages ?? []).map((name) =>
        entity(db, "languages", name)
      ),
    };
  for (const copy of fields.copies ?? []) {
    delete copy.audio_languages;
    delete copy.subtitle_languages;
  }
  return {
    fields,
    relations,
    copyLanguages,
    locks: previous?.locks ?? [],
    sources: previous?.sources ?? {},
    published: previous?.published ?? false,
  };
}
// pt-BR subtitles always come first; the rest keep their order.
const isPtBr = (name) => ["pt-BR", "Português (Brasil)"].includes(name);
const ptBrFirst = (names) => [
  ...names.filter(isPtBr),
  ...names.filter((name) => !isPtBr(name)),
];
export function exportFilm(db, row) {
  const record = structuredClone(row.fields);
  for (const [field, kind] of Object.entries(relationFields))
    record[field] = (row.relations[field] ?? []).map(
      (id) => db.entities[kind][id].name
    );
  for (const copy of record.copies ?? []) {
    const languages = row.copyLanguages[copy.id];
    if (languages) {
      copy.audio_languages = languages.audio.map(
        (id) => db.entities.languages[id].name
      );
      copy.subtitle_languages = ptBrFirst(
        languages.subtitles.map((id) => db.entities.languages[id].name)
      );
    }
  }
  return record;
}
export function seedDatabase(records) {
  const db = emptyDatabase();
  for (const record of records) {
    const key = record.tmdb_id
      ? `tmdb:${record.tmdb_id}`
      : `local:${record.id}`;
    db.films[key] = normalizeFilm(db, record);
    db.films[key].published = true;
  }
  return db;
}
export const allRecords = (db) =>
  Object.values(db.films).map((row) => exportFilm(db, row));
export const publicRecords = (db) =>
  Object.values(db.films)
    .filter((row) => row.published)
    .map((row) => exportFilm(db, row));
const leaves = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? leaves(entry, path)
      : [[path, entry]];
  });
function get(value, path) {
  return path.split(".").reduce((obj, key) => obj?.[key], value);
}
function set(value, path, entry) {
  const parts = path.split(".");
  let obj = value;
  for (const key of parts.slice(0, -1)) obj = obj[key] ??= {};
  obj[parts.at(-1)] = entry;
}
export function saveManual(db, record, published) {
  const next = structuredClone(db);
  const matches = Object.entries(next.films).filter(
    ([key, row]) =>
      row.fields.id === record.id ||
      row.fields.slug === record.slug ||
      (record.tmdb_id && row.fields.tmdb_id === record.tmdb_id)
  );
  if (matches.length > 1)
    throw Error("Identificadores apontam para filmes diferentes.");
  const found = matches[0];
  const [key, previous] = found ?? [
    record.tmdb_id ? `tmdb:${record.tmdb_id}` : `local:${record.id}`,
    undefined,
  ];
  if (
    previous &&
    (previous.fields.id !== record.id || previous.fields.slug !== record.slug)
  )
    throw Error("Identidade em conflito.");
  const old = previous ? exportFilm(next, previous) : {};
  record = structuredClone(record);
  const metadataLocks = [];
  for (const field of ["countries", "genres", "original_languages"])
    if (previous && stable(record[field]) !== stable(old[field])) {
      for (const lang of ["pt-BR", "en"]) {
        if (record.localized_metadata?.[lang])
          delete record.localized_metadata[lang][field];
        metadataLocks.push(`localized_metadata.${lang}.${field}`);
      }
    }
  const row = normalizeFilm(next, record, previous);
  row.locks = [
    ...new Set([
      ...row.locks,
      ...metadataLocks,
      ...leaves(record)
        .filter(
          ([path, value]) =>
            stable(value) !== stable(get(old, path)) &&
            (previous ||
              (value != null &&
                value !== "" &&
                (!Array.isArray(value) || value.length)))
        )
        .map(([path]) => path),
    ]),
  ];
  row.published = published;
  next.films[key] = row;
  next.revision++;
  return next;
}
export function planImport(db, input, schema, publicDir) {
  if (!Array.isArray(input))
    throw Error("O JSON deve conter uma lista de filmes.");
  if (input.length > 10000)
    throw Error("Limite de 10.000 filmes por importação.");
  const next = structuredClone(db),
    items = [],
    seen = new Set();
  const indices = { tmdb: new Map(), id: new Map(), slug: new Map() };
  for (const [key, row] of Object.entries(next.films)) {
    if (row.fields.tmdb_id) indices.tmdb.set(row.fields.tmdb_id, key);
    indices.id.set(row.fields.id, key);
    indices.slug.set(row.fields.slug, key);
  }
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    const result = {
      index,
      title: raw?.title ?? `#${index + 1}`,
      status: "rejected",
      reasons: [],
      protected: [],
    };
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw Error("Registro inválido.");
      const { entity_refs, ...source } = raw;
      const shape = structuredClone(schema.items);
      shape.required = [];
      if (entity_refs) {
        for (const [field, values] of Object.entries(entity_refs)) {
          if (
            !Object.hasOwn(relationFields, field) ||
            !Array.isArray(values) ||
            values.some(
              (ref) =>
                !ref ||
                typeof ref !== "object" ||
                Object.keys(ref).some(
                  (key) => !["id", "labels"].includes(key)
                ) ||
                typeof ref.id !== "string" ||
                !/^[-a-zA-Z0-9]+$/.test(ref.id)
            )
          )
            throw Error("Referências de entidades inválidas.");
        }
      }
      shape.properties.poster = { type: ["string", "null"] };
      shape.properties.copies.items.required = ["id"];
      shape.properties.year = {
        ...shape.properties.year,
        type: ["integer", "null"],
      };
      shape.properties.copies.items.properties.resolution = {
        type: ["string", "null"],
      };
      shape.properties.copies.items.properties.size_gib = {
        type: ["number", "null"],
        exclusiveMinimum: 0,
      };
      const errors = [];
      checkSchema(source, shape, "filme", errors);
      if (errors.length) throw Error(errors.join("\n"));
      for (const link of source.external_links ?? []) {
        const error = validateLink(link);
        if (error) throw Error(`external_links.url: ${error}`);
      }
      if (!source.tmdb_id && !(source.id && source.slug && source.title))
        throw Error("Informe tmdb_id ou id, slug e título estáveis.");
      const matched = [
        indices.tmdb.get(source.tmdb_id),
        indices.id.get(source.id),
        indices.slug.get(source.slug),
      ].filter(Boolean);
      if (new Set(matched).size > 1)
        throw Error("Identificadores apontam para filmes diferentes.");
      const key =
        matched[0] ??
        (source.tmdb_id ? `tmdb:${source.tmdb_id}` : `local:${source.id}`);
      if (seen.has(key)) {
        result.status = "ignored";
        result.reasons = ["Registro repetido no mesmo arquivo."];
        items.push(result);
        continue;
      }
      seen.add(key);
      const previous = next.films[key];
      const old = previous ? exportFilm(next, previous) : {};
      if (
        previous &&
        source.tmdb_id &&
        old.tmdb_id &&
        source.tmdb_id !== old.tmdb_id
      )
        throw Error("tmdb_id em conflito.");
      const defaults = {
        id: source.id ?? `tmdb-${source.tmdb_id}`,
        slug: source.slug ?? `tmdb-${source.tmdb_id}`,
        title: source.title ?? "",
        year: source.year ?? null,
        directors: [],
        countries: [],
        copies: [],
        catalog_copy_id: "",
        poster: "",
        external_links: [],
        selections: [],
      };
      const merged = previous ? structuredClone(old) : defaults;
      for (const [path, value] of leaves(source)) {
        if (previous && ["id", "slug"].includes(path)) continue;
        const locked = previous?.locks.some(
          (lock) => path === lock || path.startsWith(lock + ".")
        );
        if (locked) {
          if (stable(value) !== stable(get(merged, path)))
            result.protected.push(path);
          continue;
        }
        if ((value !== null && value !== "") || !previous)
          set(merged, path, value);
      }
      // A protected manual relationship must not acquire IDs from different incoming names.
      const safeRefs = Object.fromEntries(
        Object.entries(entity_refs ?? {}).filter(
          ([field]) => stable(merged[field]) === stable(source[field])
        )
      );
      const row = normalizeFilm(next, merged, previous, safeRefs);
      const normalized = exportFilm(next, row);
      const pending = validateCatalog([normalized], schema, publicDir);
      row.published = pending.length === 0;
      row.sources = { ...row.sources, lastImport: hash(stable(source)) };
      if (
        previous &&
        stable(old) === stable(normalized) &&
        previous.published === row.published
      ) {
        result.status = "ignored";
      } else {
        result.status = previous ? "updated" : "created";
        next.films[key] = row;
        indices.id.set(merged.id, key);
        indices.slug.set(merged.slug, key);
        if (merged.tmdb_id) indices.tmdb.set(merged.tmdb_id, key);
      }
      result.publicReady = row.published;
      result.reasons = pending;
      result.title = merged.title || `TMDB #${merged.tmdb_id}`;
    } catch (error) {
      result.reasons = [error.message];
    }
    items.push(result);
  }
  next.revision = db.revision + 1;
  return {
    database: next,
    baseRevision: db.revision,
    items,
    summary: Object.fromEntries(
      ["created", "updated", "ignored", "rejected"].map((status) => [
        status,
        items.filter((item) => item.status === status).length,
      ])
    ),
  };
}

// Additive publication updates. Import remains a separate, replacement-oriented API.
export function planPublication(
  db,
  record,
  schema,
  publicDir,
  sha256,
  provenance = {}
) {
  const matches = Object.entries(db.films).filter(
    ([, row]) =>
      row.fields.tmdb_id === record.tmdb_id ||
      row.fields.id === record.id ||
      row.fields.slug === record.slug
  );
  if (matches.length > 1) throw Error("PUBLICATION_IDENTITY_CONFLICT");
  const [key, row] = matches[0] ?? [];
  const old = row ? exportFilm(db, row) : undefined;
  if (old && old.tmdb_id !== record.tmdb_id)
    throw Error("PUBLICATION_IDENTITY_CONFLICT");
  const incoming = structuredClone(record);
  if (old) {
    incoming.id = old.id;
    incoming.slug = old.slug;
    incoming.catalog_copy_id = old.catalog_copy_id;
    incoming.selections = old.selections;
    incoming.copies = structuredClone(old.copies);
    for (const copy of record.copies ?? []) {
      const known = incoming.copies.find((c) => c.id === copy.id);
      const proof = row.sources?.copySha256?.[copy.id];
      if (proof && proof !== sha256)
        throw Error("PUBLICATION_COPY_IDENTITY_CONFLICT");
      if (
        known &&
        Object.keys({ ...known, ...copy }).some(
          (field) =>
            JSON.stringify(known[field]) !== JSON.stringify(copy[field])
        )
      )
        throw Error("PUBLICATION_COPY_METADATA_CONFLICT");
      if (!known) incoming.copies.push(copy);
    }
    incoming.external_links = structuredClone(old.external_links);
    for (const link of record.external_links ?? []) {
      if (
        !incoming.external_links.some(
          (l) =>
            l.provider === link.provider &&
            l.url === link.url &&
            l.copy_id === link.copy_id
        )
      )
        incoming.external_links.push(link);
    }
  }
  if (!incoming.title) delete incoming.title;
  if (!incoming.directors?.length) delete incoming.directors;
  const plan = planImport(db, [incoming], schema, publicDir);
  if (plan.items[0].protected.length)
    throw Error(
      "PUBLICATION_EDITORIAL_CONFLICT: " + plan.items[0].protected.join(", ")
    );
  if (plan.summary.rejected) throw Error(plan.items[0].reasons.join("\n"));
  const target = key ?? `tmdb:${record.tmdb_id}`;
  const next = plan.database.films[target];
  next.sources.copySha256 = { ...next.sources.copySha256 };
  for (const copy of record.copies ?? [])
    next.sources.copySha256[copy.id] = sha256;
  // Private provenance, such as an unreviewed translation, never reaches the public record.
  if (!old) Object.assign(next.sources, provenance);
  // A repeated receipt must not increment the revision or rewrite source provenance.
  if (
    JSON.stringify({ ...plan.database, revision: db.revision }) ===
    JSON.stringify(db)
  )
    plan.database.revision = db.revision;
  return plan;
}
