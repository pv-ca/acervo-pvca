// One writer lock and recoverable journal for every normalized catalog writer.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  seedDatabase,
  allRecords,
  publicRecords,
  saveManual,
} from "./database.mjs";
export const editorialVersion = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fingerprint = (db) => JSON.stringify(db);
export const atomicJson = (file, value) =>
  atomicText(file, JSON.stringify(value, null, 2) + "\n");
function atomicText(file, text) {
  mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, {
    mode: 0o600,
    flag: "wx",
  });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directory = openSync(resolve(file, ".."), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
const site = fileURLToPath(new URL("../../", import.meta.url));
// Published order and Prettier layout are kept, so a new film is a small diff that CI accepts.
export function writeCatalog(file, records) {
  const rank = new Map(
    (existsSync(file) ? read(file) : []).map((film, index) => [film.id, index])
  );
  const ordered = [...records].sort(
    (a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
      a.id.localeCompare(b.id)
  );
  atomicText(
    file,
    execFileSync(
      process.execPath,
      [
        resolve(site, "node_modules/prettier/bin/prettier.cjs"),
        "--stdin-filepath",
        resolve(site, "data/public/catalog.json"),
      ],
      {
        cwd: site,
        input: JSON.stringify(ordered, null, 2),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }
    )
  );
}
export function withStoreLock(root, action, timeout = 10000) {
  const dir = resolve(root, ".local-admin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = resolve(dir, "writer.lock");
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A stale lock is reported for explicit recovery; never steal another writer lock.
      if (Date.now() - start >= timeout)
        throw Error("CATALOG_WRITER_BUSY", { cause: error });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  writeFileSync(resolve(lock, "pid"), String(process.pid));
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true });
  }
}
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
function recover(root) {
  const journal = resolve(root, ".local-admin/transaction.json");
  if (!existsSync(journal)) return;
  const transaction = read(journal);
  const pending =
    transaction.kind === "admin-v1" ? transaction.database : transaction;
  atomicJson(resolve(root, ".local-admin/database.json"), pending);
  writeCatalog(
    resolve(root, "data/public/catalog.json"),
    publicRecords(pending)
  );
  if (transaction.kind === "admin-v1") {
    atomicJson(
      resolve(root, "data/public/editorial.json"),
      transaction.editorial
    );
    atomicJson(resolve(root, ".local-admin/drafts.json"), transaction.drafts);
  }
  unlinkSync(journal);
}
function load(root) {
  recover(root);
  const records = read(resolve(root, "data/public/catalog.json"));
  const file = resolve(root, ".local-admin/database.json");
  let db = existsSync(file) ? read(file) : seedDatabase(records);
  const old = new Map(allRecords(db).map((record) => [record.id, record]));
  for (const record of records)
    if (JSON.stringify(old.get(record.id)) !== JSON.stringify(record))
      db = saveManual(db, record, true);
  return db;
}
export const readDatabase = (root) => withStoreLock(root, () => load(root));
export function updateDatabase(root, change, expected) {
  return withStoreLock(root, () => {
    const before = load(root);
    if (expected !== undefined && fingerprint(before) !== expected)
      throw Error("CATALOG_CHANGED_REVALIDATE");
    const next = change(structuredClone(before));
    if (fingerprint(next) === fingerprint(before)) return before;
    atomicJson(
      resolve(
        root,
        `.local-admin/backups/database-${Date.now()}-${randomUUID()}.json`
      ),
      before
    );
    atomicJson(resolve(root, ".local-admin/transaction.json"), next);
    recover(root);
    return next;
  });
}

// Keep catalog, editorial references and drafts behind the same recoverable writer boundary.
export function updateAdminStore(root, change, expectedEditorial) {
  return withStoreLock(root, () => {
    const database = load(root);
    const editorial = read(resolve(root, "data/public/editorial.json"));
    if (
      expectedEditorial !== undefined &&
      editorialVersion(editorial) !== expectedEditorial
    )
      throw Error(
        "Os dados mudaram em outra janela. Reabra a seção antes de salvar."
      );
    const draftFile = resolve(root, ".local-admin/drafts.json");
    const before = {
      kind: "admin-v1",
      database,
      editorial,
      drafts: existsSync(draftFile) ? read(draftFile) : [],
    };
    const next = change(structuredClone(before));
    atomicJson(
      resolve(
        root,
        `.local-admin/backups/admin-${Date.now()}-${randomUUID()}.json`
      ),
      before
    );
    atomicJson(resolve(root, ".local-admin/transaction.json"), next);
    recover(root);
    return next;
  });
}
