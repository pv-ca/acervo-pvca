import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  prepare,
  apply,
  status,
  validateReceipt,
  atomicJson,
} from "./lib/site-sync.mjs";
import { readDatabase, updateDatabase, fingerprint } from "./lib/store.mjs";
import { saveManual, allRecords } from "./lib/database.mjs";
const schema = JSON.parse(
  readFileSync(
    new URL("../data/schema/public-catalog.schema.json", import.meta.url)
  )
);
const roots = [];
const hash = (b) => createHash("sha256").update(b).digest("hex");
function environment() {
  const root = mkdtempSync(resolve(tmpdir(), "pvca-sync-"));
  roots.push(root);
  mkdirSync(resolve(root, "data/schema"), { recursive: true });
  mkdirSync(resolve(root, "data/public"), { recursive: true });
  mkdirSync(resolve(root, "public/posters"), { recursive: true });
  atomicJson(resolve(root, "data/schema/public-catalog.schema.json"), schema);
  atomicJson(resolve(root, "data/public/catalog.json"), []);
  writeFileSync(resolve(root, "public/posters/test.png"), "test");
  writeFileSync(resolve(root, "proof.json"), "verified source evidence");
  return root;
}
function receipt(
  root,
  id = "event",
  provider = "internet_archive",
  copy = "copy-one"
) {
  return {
    version: 1,
    event_id: id,
    batch_id: "batch",
    authorization: { site: true, reference: "current user request" },
    record: {
      tmdb_id: 123,
      id: "film-123",
      slug: "test-film-2000",
      title: "Test film",
      year: 2000,
      directors: ["Director"],
      countries: ["France"],
      poster: "/posters/test.png",
      copies: [
        {
          id: copy,
          resolution: "1080p",
          size_gib: 1,
          audio_languages: ["en"],
          subtitle_languages: ["pt-BR"],
        },
      ],
      catalog_copy_id: copy,
      external_links: [],
      selections: [],
      translations: {
        "pt-BR": { synopsis: "Texto" },
        en: { synopsis: "Text" },
      },
    },
    destination:
      provider === "internet_archive"
        ? { provider, identifier: "test-film" }
        : {
            provider,
            folder_id: "film_folder_123",
            is_film_folder: true,
            shared: false,
          },
    verification: {
      status: "VERIFIED",
      adapter: provider === "internet_archive" ? "archive-job" : "rclone-check",
      bytes: 2 ** 30,
      sha256: "a".repeat(64),
      public_status: "VERIFIED_PUBLIC_DESCRIPTION",
      evidence: [
        {
          path: resolve(root, "proof.json"),
          sha256: hash(readFileSync(resolve(root, "proof.json"))),
        },
      ],
    },
  };
}
async function stage(root, input) {
  await prepare(root, input, { enrich: false });
  return apply(root, "batch");
}
test("same receipt is idempotent; no duplicate copy, film or revision", async () => {
  const root = environment(),
    input = receipt(root);
  await stage(root, input);
  const before = readDatabase(root);
  await stage(root, input);
  const after = readDatabase(root);
  assert.deepEqual(after, before);
  assert.equal(allRecords(after).length, 1);
});
test("Archive and shared Drive are additive destinations on one proven copy", async () => {
  const root = environment();
  await stage(root, receipt(root));
  const drive = receipt(root, "drive", "google_drive");
  drive.destination.shared = true;
  Object.assign(drive.verification, {
    permission: "anyone-reader",
    public_folder_id: "film_folder_123",
  });
  await stage(root, drive);
  const film = allRecords(readDatabase(root))[0];
  assert.equal(film.copies.length, 1);
  assert.equal(film.external_links.length, 2);
  assert.match(film.external_links[1].url, /\/folders\/film_folder_123$/);
});
test("distinct copies stay separate and preserve catalog copy and manual curation", async () => {
  const root = environment();
  await stage(root, receipt(root));
  updateDatabase(root, (db) => {
    const f = allRecords(db)[0];
    f.selections = ["My selection"];
    return saveManual(db, f, true);
  });
  const next = receipt(root, "second", "internet_archive", "copy-two");
  next.verification.sha256 = "b".repeat(64);
  next.destination.identifier = "second-copy";
  await stage(root, next);
  const film = allRecords(readDatabase(root))[0];
  assert.equal(film.copies.length, 2);
  assert.equal(film.catalog_copy_id, "copy-one");
  assert.deepEqual(film.selections, ["My selection"]);
});
test("manual text conflict is pending, preserves published work", async () => {
  const root = environment();
  await stage(root, receipt(root));
  updateDatabase(root, (db) => {
    const film = allRecords(db)[0];
    film.translations.en.synopsis = "Manual";
    return saveManual(db, film, true);
  });
  const before = readDatabase(root);
  const result = await stage(root, receipt(root, "again"));
  assert.equal(result.events.again.status, "PENDING");
  assert.deepEqual(readDatabase(root), before);
});
test("private Drive publishes ficha without leaking folder IDs, source paths or hashes", async () => {
  const root = environment();
  await stage(root, receipt(root, "drive", "google_drive"));
  const text = readFileSync(resolve(root, "data/public/catalog.json"), "utf8");
  const film = JSON.parse(text)[0];
  assert.deepEqual(film.external_links, []);
  for (const privateText of [
    "film_folder_123",
    root,
    "sha256",
    "verification",
    "authorization",
  ])
    assert.ok(!text.includes(privateText));
});
test("unshared folder, director-folder ambiguity and wrong sharing proof rejected", () => {
  const root = environment();
  const r = receipt(root, "drive", "google_drive");
  r.destination.is_film_folder = false;
  assert.throws(() => validateReceipt(r, schema), /FILM_FOLDER/);
  r.destination.is_film_folder = true;
  r.destination.shared = true;
  assert.throws(() => validateReceipt(r, schema), /SHARING_PROOF/);
});
test("incomplete poster stays private; batch applies ready items independently", async () => {
  const root = environment();
  await prepare(root, receipt(root), { enrich: false });
  const draft = receipt(root, "draft");
  Object.assign(draft.record, {
    id: "other",
    slug: "other",
    tmdb_id: 124,
    poster: null,
  });
  await prepare(root, draft, { enrich: false });
  const queue = apply(root, "batch");
  assert.equal(queue.events.event.status, "APPLIED");
  assert.equal(queue.events.draft.status, "DRAFT");
  assert.equal(
    JSON.parse(readFileSync(resolve(root, "data/public/catalog.json"))).length,
    1
  );
});
test("pending upload, absent authorization and private extra fields rejected before mutation", async () => {
  const root = environment();
  const r = receipt(root);
  r.verification.status = "PENDING";
  await assert.rejects(prepare(root, r, { enrich: false }));
  r.verification.status = "VERIFIED";
  r.authorization.site = false;
  await assert.rejects(prepare(root, r, { enrich: false }));
  r.authorization.site = true;
  r.record.local_path = "/PRIVATE";
  await assert.rejects(prepare(root, r, { enrich: false }));
  assert.equal(readDatabase(root).revision, 0);
});
test("receipt/evidence drift and conflicting byte identity do not overwrite catalog", async () => {
  const root = environment();
  const r = receipt(root);
  await stage(root, r);
  const changed = structuredClone(r);
  changed.record.title = "Changed";
  await assert.rejects(
    prepare(root, changed, { enrich: false }),
    /EVENT_ID_REUSED/
  );
  const conflict = receipt(root, "conflict");
  conflict.verification.sha256 = "b".repeat(64);
  assert.equal((await stage(root, conflict)).events.conflict.status, "PENDING");
  const drift = receipt(root, "drift");
  await prepare(root, drift, { enrich: false });
  writeFileSync(resolve(root, "proof.json"), "changed");
  assert.equal(apply(root, "batch").events.drift.status, "PENDING");
});
test("transaction CAS and interrupted journal recovery", () => {
  const root = environment(),
    before = readDatabase(root);
  updateDatabase(root, (db) => {
    db.revision++;
    return db;
  });
  assert.throws(
    () => updateDatabase(root, (db) => db, fingerprint(before)),
    /CATALOG_CHANGED/
  );
  const recovery = { ...readDatabase(root), revision: 90 };
  atomicJson(resolve(root, ".local-admin/transaction.json"), recovery);
  assert.equal(readDatabase(root).revision, 90);
});
test("two processes serialize catalog writes without lost revisions", async () => {
  const root = environment();
  const module = new URL("./lib/store.mjs", import.meta.url).href;
  const code = `import {updateDatabase} from ${JSON.stringify(module)};for(let i=0;i<10;i++) updateDatabase(${JSON.stringify(root)},db=>{db.revision++;return db;});`;
  await Promise.all(
    [1, 2].map(
      () =>
        new Promise((done, reject) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            code,
          ]);
          let error = "";
          child.stderr.on("data", (b) => (error += b));
          child.on("exit", (n) => (n === 0 ? done() : reject(Error(error))));
        })
    )
  );
  assert.equal(readDatabase(root).revision, 20);
});
test.after(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }))
);

import { publish, command } from "./lib/site-deploy.mjs";
test("isolated batch deploy excludes prototype, verifies both languages and resumes same commit after push failure", async () => {
  const root = environment();
  await command(["git", "init", "-b", "main"], root);
  await command(["git", "config", "user.email", "test@example.invalid"], root);
  await command(["git", "config", "user.name", "Test"], root);
  await command(
    [
      "git",
      "remote",
      "add",
      "origin",
      "https://github.com/pv-ca/acervo-pvca.git",
    ],
    root
  );
  writeFileSync(resolve(root, ".gitignore"), ".local-admin/\n");
  await command(["git", "add", "."], root);
  await command(["git", "commit", "-m", "base"], root);
  writeFileSync(resolve(root, "prototype.txt"), "unrelated work");
  await stage(root, receipt(root));
  let first = true,
    pushes = 0,
    builds = 0;
  const run = async (argv, cwd) => {
    if (argv[0] === "git" && argv[1] === "fetch")
      return command(
        ["git", "fetch", root, "main:refs/remotes/origin/main"],
        cwd
      );
    if (argv[0] === "git" && argv[1] === "push") {
      pushes++;
      if (first) {
        first = false;
        throw Error("SIMULATED_PUSH_FAILURE");
      }
      return "";
    }
    if (argv[0] === "npm" || argv[0] === "python3") return "";
    if (argv[0] === "npx") {
      builds++;
      assert.ok(
        !readFileSync(
          resolve(cwd, "data/public/catalog.json"),
          "utf8"
        ).includes("verification")
      );
      for (const prefix of ["", "en/"]) {
        const dir = resolve(cwd, "dist", prefix, "filmes/test-film-2000");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          resolve(dir, "index.html"),
          prefix + "verified film page"
        );
      }
      return "";
    }
    if (argv[0] === "gh")
      return JSON.stringify([
        { databaseId: 22, status: "completed", conclusion: "success" },
      ]);
    return command(argv, cwd);
  };
  await assert.rejects(
    publish(root, "batch", { run }),
    /SIMULATED_PUSH_FAILURE/
  );
  const commit = status(root, "batch").deployment.commit;
  const fetchPage = async (url) => ({
    ok: true,
    arrayBuffer: async () =>
      Buffer.from(
        url.includes("/en/") ? "en/verified film page" : "verified film page"
      ),
  });
  const result = await publish(root, "batch", {
    run,
    fetchPage,
    sleep: async () => {},
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.deployment.commit, commit);
  assert.equal(builds, 1);
  assert.equal(pushes, 2);
  assert.equal(result.events.event.status, "PUBLISHED");
  assert.equal(result.deployment.pages.length, 2);
  const tracked = await command(["git", "ls-files"], result.deployment.staging);
  assert.ok(!tracked.includes("prototype.txt"));
  assert.ok(
    readFileSync(resolve(root, "prototype.txt"), "utf8").includes("unrelated")
  );
  await publish(root, "batch", { run, fetchPage });
  assert.equal(pushes, 2);

  // A failed Pages run stays pending until a later commit on main deploys the same pages.
  await command(["git", "fetch", result.deployment.staging, "HEAD"], root);
  await command(["git", "update-ref", "refs/heads/main", "FETCH_HEAD"], root);
  const other = receipt(root);
  other.event_id = "second";
  other.record.tmdb_id = 2;
  other.record.id = "PVCA-000002";
  other.record.slug = "second-film-2000";
  other.record.copies[0].id = other.record.catalog_copy_id = "pvca-000002-a";
  await stage(root, other);
  let repaired = [];
  const failing = async (argv, cwd) => {
    if (argv[0] === "gh")
      return JSON.stringify(
        argv.includes("--branch")
          ? repaired
          : [{ databaseId: 23, status: "completed", conclusion: "failure" }]
      );
    if (argv[1] === "merge-base" && argv[4] === "fix") return "";
    if (argv[0] === "npx") {
      await run(argv, cwd);
      for (const prefix of ["", "en/"]) {
        const dir = resolve(cwd, "dist", prefix, "filmes/second-film-2000");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          resolve(dir, "index.html"),
          prefix + "verified film page"
        );
      }
      return "";
    }
    return run(argv, cwd);
  };
  await assert.rejects(
    publish(root, "batch", { run: failing, fetchPage }),
    /PAGES_WORKFLOW_FAILED/
  );
  repaired = [
    {
      databaseId: 24,
      status: "completed",
      conclusion: "success",
      headSha: "fix",
    },
  ];
  const fixed = await publish(root, "batch", {
    run: failing,
    fetchPage,
    sleep: async () => {},
  });
  assert.equal(fixed.status, "PUBLISHED");
  assert.deepEqual(
    [fixed.deployment.workflow_id, fixed.deployment.deployed_by],
    [24, "fix"]
  );
});

import { recoverBatch } from "./lib/site-sync.mjs";
test("publisher recovery never steals a live publisher and restores an interrupted one", () => {
  const root = environment();
  const queue = {
    version: 1,
    batch_id: "batch",
    status: "PUBLISHING",
    publisher_pid: process.pid,
    events: {},
  };
  atomicJson(resolve(root, ".local-admin/site-sync/batch.json"), queue);
  assert.throws(() => recoverBatch(root, "batch"), /PUBLISHER_STILL_RUNNING/);
  queue.publisher_pid = 2147483647;
  atomicJson(resolve(root, ".local-admin/site-sync/batch.json"), queue);
  assert.equal(recoverBatch(root, "batch").status, "PENDING_PUBLICATION");
});

test("missing cinematic fields remain a private draft when enrichment is unavailable", async () => {
  const root = environment(),
    input = receipt(root);
  Object.assign(input.record, {
    title: "",
    year: null,
    directors: [],
    poster: null,
  });
  const queue = await stage(root, input);
  assert.equal(queue.events.event.status, "DRAFT");
  assert.equal(
    JSON.parse(readFileSync(resolve(root, "data/public/catalog.json"))).length,
    0
  );
});
test("an Archive item becomes a film from public evidence alone; repeats and mismatches change nothing", async () => {
  const { observeArchive, resolutionClass } =
    await import("./lib/archive-observed.mjs");
  const root = environment(),
    bytes = 3 * 2 ** 30;
  const item = {
    metadata: {
      identifier: "test-film-2000-1080p-pvca",
      title: "Test film (2000)",
      creator: "Director",
      year: "2000",
      "external-identifier": "urn:tmdb:123",
    },
    files: [
      {
        name: "Test.mkv",
        source: "original",
        size: String(bytes),
        md5: "b".repeat(32),
      },
      {
        name: "Test.mp4",
        source: "derivative",
        size: "1",
        md5: "c".repeat(32),
      },
    ],
  };
  const ffprobe = {
    format: { format_name: "matroska,webm", size: String(bytes) },
    streams: [
      { codec_type: "video", width: 1920, height: 804 },
      { codec_type: "audio", tags: { language: "fre" } },
      { codec_type: "subtitle", tags: { language: "por", title: "Brasil" } },
    ],
  };
  const options = {
    authorization: "current user request",
    batch: "batch",
    today: "2026-10-10",
    overrides: {
      countries: ["France"],
      poster: "/posters/test.png",
      translations: {
        "pt-BR": { synopsis: "Texto" },
        en: { synopsis: "Text" },
      },
    },
    metadataOf: async () => item,
    probe: async () => ffprobe,
    // TMDB names the director in the original script; the English search result carries the romanized name.
    enrich: async () => ({ title: "Filme", year: 2000, directors: ["監督"] }),
    search: async () => [{ id: 123, directors: ["Diréctor"] }],
  };
  const observe = (changes = {}) =>
    observeArchive(root, item.metadata.identifier, { ...options, ...changes });
  await assert.rejects(
    observe({
      search: async () => [{ id: 123, directors: ["Someone else"] }],
    }),
    /TMDB_DIRECTOR_DOES_NOT_MATCH/
  );
  await assert.rejects(observe({ tmdbId: 999 }), /TMDB_IDENTITY_CONFLICT/);
  await assert.rejects(
    observe({ probe: async () => ({ ...ffprobe, format: { size: "1" } }) }),
    /ARCHIVE_MEDIA_SIZE_MISMATCH/
  );
  await assert.rejects(observe({ authorization: " " }), /SITE_AUTHORIZATION/);
  assert.equal(allRecords(readDatabase(root)).length, 0);

  const observed = await observe();
  assert.equal(observed.status, "OBSERVED");
  assert.deepEqual(observed.warnings, [
    "pt-BR synopsis is a translation not yet reviewed",
  ]);
  const queue = await stage(root, observed.receipt);
  assert.equal(
    queue.events["archive-test-film-2000-1080p-pvca"].status,
    "APPLIED"
  );
  assert.equal(
    Object.values(readDatabase(root).films)[0].sources.portugueseSynopsis
      .method,
    "unreviewed_translation"
  );
  assert.ok(
    !readFileSync(resolve(root, "data/public/catalog.json"), "utf8").includes(
      "unreviewed"
    )
  );
  const [film] = allRecords(readDatabase(root));
  assert.deepEqual(
    [film.id, film.slug, film.added_at, film.copies[0].resolution],
    ["PVCA-000001", "test-film-2000", "2026-10-10", "1080p"]
  );
  assert.deepEqual([film.title, film.directors], ["Test film", ["Director"]]);
  assert.deepEqual(film.copies[0].audio_languages, ["fr"]);
  assert.deepEqual(film.copies[0].subtitle_languages, ["pt-BR"]);
  assert.equal(film.copies[0].size_gib, 3);
  assert.equal(
    film.external_links[0].url,
    "https://archive.org/details/test-film-2000-1080p-pvca"
  );
  assert.deepEqual(await observe(), {
    status: "ALREADY_ON_SITE",
    id: "PVCA-000001",
  });
  // A new Archive item of the same work adds its own copy and link; the chosen copy stays.
  const other = structuredClone(item);
  other.metadata.identifier = "test-film-2000-remaster-pvca";
  other.files[0].md5 = "d".repeat(32);
  // Extras sit beside the film; the payload named after the identifier is the film.
  other.files[0].name = "test-film-2000-remaster-pvca.mkv";
  other.files.push({
    name: "Test (2000) - Extras.mkv",
    source: "original",
    size: "5",
    md5: "e".repeat(32),
  });
  const second = await observeArchive(root, other.metadata.identifier, {
    ...options,
    metadataOf: async () => other,
  });
  assert.equal(second.status, "OBSERVED");
  await stage(root, second.receipt);
  const [updated] = allRecords(readDatabase(root));
  assert.deepEqual(
    updated.copies.map((copy) => copy.id),
    ["pvca-000001-archive", "pvca-000001-archive-2"]
  );
  assert.equal(updated.catalog_copy_id, "pvca-000001-archive");
  assert.deepEqual(
    updated.external_links.map((link) => [link.url, link.copy_id]),
    [
      [
        "https://archive.org/details/test-film-2000-1080p-pvca",
        "pvca-000001-archive",
      ],
      [
        "https://archive.org/details/test-film-2000-remaster-pvca",
        "pvca-000001-archive-2",
      ],
    ]
  );
  assert.equal(
    resolutionClass({ width: 720, height: 480, field_order: "tt" }),
    "480i"
  );
  assert.equal(resolutionClass({ width: 3840, height: 1608 }), "2160p");
  assert.equal(resolutionClass({ width: 960, height: 720 }), "720p");
});
test("a Drive film folder becomes a ficha with its link only when the folder opens without signing in", async () => {
  const { observeDrive } = await import("./lib/archive-observed.mjs");
  const bytes = 2 * 2 ** 30;
  const options = (shared) => ({
    tmdbId: 123,
    authorization: "current user request",
    batch: "batch",
    today: "2026-10-10",
    overrides: {
      countries: ["France"],
      poster: "/posters/test.png",
      translations: {
        "pt-BR": { synopsis: "Texto" },
        en: { synopsis: "Text" },
      },
    },
    enrich: async () => ({
      title: "Filme",
      year: 2000,
      directors: ["Director"],
    }),
    search: async () => [],
    remoteDrive: {
      list: async (remote, kind) =>
        kind === "--dirs-only"
          ? [
              { Name: "Test film (2000)", ID: "folder_123" },
              { Name: "Other (1999)", ID: "x" },
            ]
          : [
              {
                Name: "Test film (2000).mkv",
                Size: bytes,
                Hashes: { md5: "d".repeat(32) },
              },
              {
                Name: "Test film (2000).en.srt",
                Size: 10,
                Hashes: { md5: "e".repeat(32) },
              },
            ],
      probe: async () => ({
        format: { format_name: "matroska,webm" },
        streams: [
          { codec_type: "video", width: 1280, height: 720 },
          { codec_type: "audio", tags: { language: "eng" } },
        ],
      }),
      opensAnonymously: async () => shared,
    },
  });
  const remote = "gdrive:Acervo/Director & Other Person/Test film (2000)";
  await assert.rejects(
    observeDrive(environment(), "gdrive:Acervo/Director", options(true)),
    /DRIVE_FILM_FOLDER_REQUIRED/
  );
  for (const shared of [true, false]) {
    const root = environment();
    const observed = await observeDrive(root, remote, options(shared));
    assert.equal(
      observed.link,
      "https://drive.google.com/drive/folders/folder_123"
    );
    // Each carries the unreviewed-translation notice; the private folder adds its own.
    assert.equal(observed.warnings.length, shared ? 1 : 2);
    const queue = await stage(root, observed.receipt);
    assert.equal(queue.events["drive-folder_123"].status, "APPLIED");
    const [film] = allRecords(readDatabase(root));
    assert.deepEqual(
      [
        film.title,
        film.directors,
        film.copies[0].id,
        film.copies[0].resolution,
      ],
      ["Test film", ["Director", "Other Person"], "pvca-000001-drive", "720p"]
    );
    assert.deepEqual(
      film.external_links.map((link) => link.url),
      shared ? ["https://drive.google.com/drive/folders/folder_123"] : []
    );
    assert.equal(
      (await observeDrive(root, remote, options(shared))).status,
      "ALREADY_ON_SITE"
    );
  }
});
