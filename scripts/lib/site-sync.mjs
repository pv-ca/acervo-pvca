import { readFileSync, existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  atomicJson,
  readDatabase,
  updateDatabase,
  withStoreLock,
  fingerprint,
} from "./store.mjs";
import { planPublication, publicRecords, allRecords } from "./database.mjs";
import { checkSchema } from "./catalog.mjs";
import { enrichTmdb } from "./tmdb.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const safe = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
function requireValue(value, message) {
  if (!value) throw Error(message);
}
export function validateReceipt(receipt, schema) {
  requireValue(
    receipt?.version === 1 && safe(receipt.event_id) && safe(receipt.batch_id),
    "INVALID_RECEIPT_ID"
  );
  requireValue(
    receipt.authorization?.site === true &&
      receipt.authorization?.reference?.trim(),
    "SITE_AUTHORIZATION_REQUIRED"
  );
  const proof = receipt.verification;
  // A remotely observed Archive copy is identified by the MD5 the Archive itself publishes.
  requireValue(
    proof?.status === "VERIFIED" &&
      Number.isSafeInteger(proof.bytes) &&
      proof.bytes > 0 &&
      (/-observed$/.test(proof.adapter ?? "")
        ? /^[a-f0-9]{32}$/.test(proof.md5 ?? "") && !proof.sha256
        : /^[a-f0-9]{64}$/.test(proof.sha256 ?? "")),
    "REMOTE_VERIFICATION_REQUIRED"
  );
  requireValue(
    proof.evidence?.length &&
      proof.evidence.every((e) => e.path && /^[a-f0-9]{64}$/.test(e.sha256)),
    "BOUND_EVIDENCE_REQUIRED"
  );
  const film = structuredClone(receipt.record);
  requireValue(
    Number.isInteger(film?.tmdb_id) &&
      film.tmdb_id > 0 &&
      film.copies?.length === 1,
    "REVIEWED_WORK_AND_COPY_REQUIRED"
  );
  const copy = film.copies[0];
  requireValue(
    copy.id && copy.size_gib === proof.bytes / 2 ** 30,
    "EXACT_BYTE_SIZE_REQUIRED"
  );
  requireValue(film.catalog_copy_id === copy.id, "EXPLICIT_COPY_REQUIRED");
  requireValue(
    film.external_links?.length === 0 && film.selections?.length === 0,
    "DESTINATIONS_AND_CURATION_ARE_NOT_RECEIPT_INPUT"
  );
  const shape = structuredClone(schema.items);
  shape.required = [];
  shape.properties.poster = { type: ["string", "null"] };
  shape.properties.directors.minItems = 0;
  shape.properties.title.minLength = 0;
  shape.properties.year.type = ["integer", "null"];
  const errors = [];
  checkSchema(film, shape, "record", errors);
  requireValue(!errors.length, errors.join("\n"));
  const destination = receipt.destination;
  if (destination?.provider === "internet_archive") {
    requireValue(
      safe(destination.identifier) &&
        (proof.adapter === "archive-observed" ||
          (proof.adapter === "archive-job" &&
            proof.public_status === "VERIFIED_PUBLIC_DESCRIPTION")),
      "ARCHIVE_PUBLIC_READBACK_REQUIRED"
    );
    film.external_links.push({
      provider: "internet_archive",
      url: `https://archive.org/details/${destination.identifier}`,
      copy_id: copy.id,
    });
  } else if (destination?.provider === "google_drive") {
    requireValue(
      ["rclone-check", "drive-observed"].includes(proof.adapter) &&
        /^[a-zA-Z0-9_-]+$/.test(destination.folder_id ?? "") &&
        destination.is_film_folder === true,
      "DRIVE_FILM_FOLDER_REQUIRED"
    );
    if (destination.shared === true) {
      requireValue(
        proof.public_folder_id === destination.folder_id &&
          proof.permission === "anyone-reader",
        "DRIVE_SHARING_PROOF_REQUIRED"
      );
      film.external_links.push({
        provider: "google_drive",
        url: `https://drive.google.com/drive/folders/${destination.folder_id}`,
        copy_id: copy.id,
      });
    }
  } else throw Error("UNSUPPORTED_DESTINATION");
  return film;
}
const copyProof = (proof) => proof.sha256 ?? `md5:${proof.md5}`;
function assertEvidence(receipt) {
  for (const entry of receipt.verification.evidence) {
    const info = lstatSync(entry.path);
    requireValue(
      info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024,
      "BOUNDED_REGULAR_EVIDENCE_REQUIRED"
    );
    requireValue(
      hash(readFileSync(entry.path)) === entry.sha256,
      "VERIFICATION_EVIDENCE_CHANGED"
    );
  }
}
function queueFile(root, batch) {
  requireValue(safe(batch), "INVALID_BATCH");
  return resolve(root, ".local-admin/site-sync", `${batch}.json`);
}
export function status(root, batch) {
  const file = queueFile(root, batch);
  return existsSync(file)
    ? read(file)
    : { version: 1, batch_id: batch, events: {}, status: "NEW" };
}
export async function prepare(root, receipt, { enrich = true } = {}) {
  const schema = read(resolve(root, "data/schema/public-catalog.schema.json"));
  let film = validateReceipt(receipt, schema);
  assertEvidence(receipt);
  let enrichmentError;
  if (enrich) {
    try {
      const metadata = await enrichTmdb(root, film.tmdb_id);
      // A ficha already in the catalog keeps what it has: a gap is one in both the receipt and the ficha.
      const current =
        allRecords(readDatabase(root)).find(
          (known) => known.tmdb_id === film.tmdb_id
        ) ?? {};
      const empty = (value) =>
        value == null ||
        value === "" ||
        (Array.isArray(value) && !value.length);
      // Official metadata only fills gaps; technical copy facts remain untouched.
      for (const [field, value] of Object.entries(metadata)) {
        if (
          [
            "copies",
            "catalog_copy_id",
            "external_links",
            "selections",
            "id",
            "slug",
            "entity_refs",
          ].includes(field)
        )
          continue;
        if (field === "translations" || field === "localized_metadata") {
          film[field] ??= {};
          for (const [locale, values] of Object.entries(value ?? {})) {
            film[field][locale] ??= {};
            for (const [name, content] of Object.entries(values))
              if (
                !film[field][locale][name] &&
                !current[field]?.[locale]?.[name]
              )
                film[field][locale][name] = content;
          }
        } else if (empty(film[field]) && empty(current[field]))
          film[field] = value;
      }
      if (metadata.entity_refs)
        film.entity_refs = Object.fromEntries(
          Object.entries(metadata.entity_refs).filter(
            ([field]) =>
              JSON.stringify(film[field]) === JSON.stringify(metadata[field])
          )
        );
    } catch (error) {
      enrichmentError = error.message;
    }
  }
  const digest = hash(JSON.stringify(receipt));
  return withStoreLock(root, () => {
    const queue = status(root, receipt.batch_id);
    if (queue.status === "PUBLISHING")
      throw Error("BATCH_PUBLICATION_IN_PROGRESS");
    const previous = queue.events[receipt.event_id];
    if (previous) {
      requireValue(
        previous.receipt_digest === digest,
        "EVENT_ID_REUSED_WITH_DIFFERENT_RECEIPT"
      );
      return previous;
    }
    const event = {
      receipt_digest: digest,
      receipt,
      record: film,
      status: "PREPARED",
      enrichmentError,
    };
    queue.events[receipt.event_id] = event;
    queue.status = "PREPARED";
    atomicJson(queueFile(root, receipt.batch_id), queue);
    return event;
  });
}
export function apply(root, batch) {
  // Queue and catalog updates each hold the same lock, never nest it.
  const queue = status(root, batch);
  if (queue.status === "PUBLISHING")
    throw Error("BATCH_PUBLICATION_IN_PROGRESS");
  const schema = read(resolve(root, "data/schema/public-catalog.schema.json"));
  for (const event of Object.values(queue.events)) {
    if (["APPLIED", "PUBLISHED"].includes(event.status)) continue;
    try {
      requireValue(
        hash(JSON.stringify(event.receipt)) === event.receipt_digest,
        "RECEIPT_CHANGED"
      );
      const verified = validateReceipt(event.receipt, schema);
      requireValue(
        JSON.stringify(event.record.copies) ===
          JSON.stringify(verified.copies) &&
          JSON.stringify(event.record.external_links) ===
            JSON.stringify(verified.external_links) &&
          !event.record.selections?.length,
        "QUEUE_PUBLICATION_FACTS_CHANGED"
      );
      assertEvidence(event.receipt);
      let plan;
      updateDatabase(root, (db) => {
        if (status(root, batch).status === "PUBLISHING")
          throw Error("BATCH_PUBLICATION_IN_PROGRESS");
        plan = planPublication(
          db,
          event.record,
          schema,
          resolve(root, "public"),
          copyProof(event.receipt.verification),
          event.receipt.provenance
        );
        return plan.database;
      });
      event.status = plan.items[0].publicReady ? "APPLIED" : "DRAFT";
      event.result = plan.items[0];
      delete event.error;
    } catch (error) {
      event.status = "PENDING";
      event.error = error.message;
    }
  }
  // CAS prevents another queue writer from losing events while catalog operations run.
  const file = queueFile(root, batch);
  withStoreLock(root, () => {
    const current = status(root, batch);
    if (current.status === "PUBLISHING")
      throw Error("BATCH_PUBLICATION_IN_PROGRESS");
    for (const [id, event] of Object.entries(queue.events)) {
      requireValue(
        current.events[id]?.receipt_digest === event.receipt_digest,
        "QUEUE_CHANGED"
      );
      if (current.events[id]?.status !== "PUBLISHED")
        current.events[id] = event;
    }
    current.status = "APPLIED";
    atomicJson(file, current);
  });
  return status(root, batch);
}
export function publicSnapshot(root) {
  const db = readDatabase(root);
  return { fingerprint: fingerprint(db), records: publicRecords(db) };
}
export { atomicJson, queueFile, read, hash };

export function recoverBatch(root, batch) {
  return withStoreLock(root, () => {
    const queue = status(root, batch);
    if (queue.status !== "PUBLISHING") return queue;
    requireValue(
      Number.isInteger(queue.publisher_pid) && queue.publisher_pid > 0,
      "PUBLISHER_IDENTITY_UNKNOWN"
    );
    try {
      process.kill(queue.publisher_pid, 0);
      throw Error("PUBLISHER_STILL_RUNNING");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    queue.status = "PENDING_PUBLICATION";
    queue.error =
      "Interrupted publisher; resume prepared deployment without reupload";
    delete queue.publisher_pid;
    atomicJson(queueFile(root, batch), queue);
    return queue;
  });
}
