// Site receipts built only from what the destination itself serves: an Internet Archive item or a
// Google Drive film folder. No local media and no upload job are needed, so any transport can end here.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomicJson, readDatabase } from "./store.mjs";
import { allRecords } from "./database.mjs";
import { convertObserved } from "./observed.mjs";
import { enrichTmdb, searchTmdb } from "./tmdb.mjs";

const fold = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
const MEDIA = /\.(mkv|mp4|avi)$/i;
const list = (value) => (value == null ? [] : [value].flat());
function requireValue(value, message) {
  if (!value) throw Error(message);
}
async function fetchMetadata(identifier) {
  const response = await fetch(`https://archive.org/metadata/${identifier}`, {
    signal: AbortSignal.timeout(60000),
  });
  requireValue(response.ok, "ARCHIVE_METADATA_UNAVAILABLE");
  return response.json();
}
const PROBE = ["-v", "error", "-print_format", "json", "-show_format"].concat(
  "-show_streams"
);
// JSON printed by a fixed program started without a shell; arguments are never interpreted as commands.
function printed(child, failure) {
  return new Promise((done, reject) => {
    let text = "";
    const timer = setTimeout(() => child.kill(), 300000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.length > 16 * 1024 * 1024) child.kill();
    });
    child.on("error", () => reject(Error(failure)));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        done(JSON.parse(text));
      } catch {
        reject(Error(failure));
      }
    });
  });
}
const quiet = { stdio: ["ignore", "pipe", "ignore"] };
const remoteProbe = (url) =>
  printed(spawn("ffprobe", [...PROBE, url], quiet), "MEDIA_PROBE_FAILED");
// Read-only Drive access: listings with hashes, and the container header streamed into ffprobe.
const drive = {
  list: (remote, kind) =>
    printed(
      spawn("rclone", ["lsjson", remote, kind, "--hash"], quiet),
      "DRIVE_LISTING_UNAVAILABLE"
    ),
  // ffprobe stops reading once it has the header; the truncated stream is then closed, not an error.
  async probe(remote) {
    const source = spawn(
      "rclone",
      ["cat", remote, "--head", "33554432"],
      quiet
    );
    const reader = spawn("ffprobe", [...PROBE, "-i", "pipe:0"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    reader.stdin.on("error", () => {});
    source.on("error", () => reader.stdin.end());
    source.stdout.pipe(reader.stdin);
    try {
      return await printed(reader, "MEDIA_PROBE_FAILED");
    } finally {
      source.kill();
    }
  },
  // A folder that opens without signing in is shared with anyone who has the link.
  async opensAnonymously(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return response.ok && !new URL(response.url).host.startsWith("accounts.");
  },
};
// Source class from the encoded raster; cropped widescreen keeps its class through the width.
export function resolutionClass(video) {
  const { width, height } = video;
  const scan = ["tt", "bb", "tb", "bt"].includes(video.field_order) ? "i" : "p";
  const lines =
    width >= 3000 || height >= 1700
      ? 2160
      : width >= 1500 || height >= 900
        ? 1080
        : width >= 1000 || height >= 650
          ? 720
          : height > 480
            ? 576
            : 480;
  return lines + scan;
}

async function receiptFor(root, source, options) {
  const {
    tmdbId,
    authorization,
    batch,
    overrides = {},
    today = new Date().toISOString().slice(0, 10),
    enrich = enrichTmdb,
    search = searchTmdb,
  } = options;
  const { provider, url, bytes, md5, ffprobe } = source;
  requireValue(
    Number.isSafeInteger(bytes) &&
      bytes > 0 &&
      /^[a-f0-9]{32}$/.test(md5 ?? ""),
    "REMOTE_FILE_IDENTITY_UNAVAILABLE"
  );
  // Identity: the reviewed TMDB id comes from the caller or from the item itself, never from a title search.
  requireValue(
    tmdbId == null ||
      !source.declared.length ||
      source.declared.includes(tmdbId),
    "TMDB_IDENTITY_CONFLICT"
  );
  const tmdb =
    tmdbId ?? (source.declared.length === 1 ? source.declared[0] : undefined);
  requireValue(Number.isInteger(tmdb) && tmdb > 0, "TMDB_IDENTITY_REQUIRED");
  const work = await enrich(root, tmdb);
  // The destination's title and creator are the reviewed PVCA names; TMDB must describe the same work.
  requireValue(
    source.title && source.creators.length,
    "REVIEWED_TITLE_AND_CREATOR_REQUIRED"
  );
  const candidates = [
    ...(work.directors ?? []),
    ...((await search(root, source.title, work.year)).find(
      (match) => match.id === tmdb
    )?.directors ?? []),
  ].map(fold);
  requireValue(
    source.creators.some((creator) => candidates.includes(fold(creator))),
    "TMDB_DIRECTOR_DOES_NOT_MATCH_REVIEWED_CREATOR"
  );

  const films = allRecords(readDatabase(root));
  const known = films.find((film) => film.tmdb_id === tmdb);
  const id =
    known?.id ??
    "PVCA-" +
      String(
        Math.max(0, ...films.map((film) => Number(film.id.split("-")[1]))) + 1
      ).padStart(6, "0");
  if (
    known?.copies.some((copy) => copy.id === `${id.toLowerCase()}-${provider}`)
  )
    return { status: "ALREADY_ON_SITE", id };
  const title = overrides.title ?? known?.title ?? source.title,
    year = known?.year ?? work.year;
  const video = ffprobe.streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic
  );
  const converted = convertObserved(
    {
      schema_version: "pvca-clean-catalog-6.2-subset",
      item_count: 1,
      items: [
        {
          pvca_id: id,
          title,
          year,
          identity: { tmdb: { id: tmdb } },
          availability: { preferred_media_source: provider.toUpperCase() },
          copies: {
            [provider]: {
              status: "AVAILABLE",
              url,
              resolution: {
                declared_class: video ? resolutionClass(video) : null,
              },
            },
          },
        },
      ],
    },
    {
      schema_version: "pvca-remote-technical-observation-1",
      observations: [
        {
          pvca_id: id,
          title,
          year,
          observed_copy: {
            source: provider.toUpperCase(),
            source_url: url,
            size_bytes: bytes,
            ffprobe,
          },
        },
      ],
    }
  );
  requireValue(
    !converted.failures.length,
    "OBSERVED_COPY_REJECTED: " + converted.failures[0]?.error
  );
  const [projected] = converted.records;
  let slug = known?.slug ?? projected.slug;
  if (!known && films.some((film) => film.slug === slug))
    slug += "-" + id.toLowerCase();
  const record = {
    id,
    slug,
    title,
    year,
    tmdb_id: tmdb,
    ...(known ? {} : { added_at: today, directors: source.creators }),
    ...overrides,
    copies: projected.copies,
    // A work already in the catalog keeps the copy chosen for its ficha.
    catalog_copy_id: known?.catalog_copy_id ?? projected.catalog_copy_id,
    external_links: [],
    selections: [],
  };

  const folder = resolve(root, ".local-admin/site-sync/evidence", source.key);
  const evidence = Object.entries({ ...source.evidence, ffprobe }).map(
    ([name, value]) => {
      const path = resolve(folder, `${name}.json`);
      atomicJson(path, value);
      return {
        path,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    }
  );
  const warnings = [...(source.warnings ?? [])];
  if (source.year && source.year !== work.year)
    warnings.push(
      `Reviewed year ${source.year} differs from TMDB ${work.year}`
    );
  // Without an official pt-BR text the ficha still goes out; a supplied translation is recorded as unreviewed.
  let provenance;
  if (!known && !work.translations?.["pt-BR"]?.synopsis) {
    if (overrides.translations?.["pt-BR"]?.synopsis) {
      provenance = {
        portugueseSynopsis: {
          method: "unreviewed_translation",
          source: "site_tail_overrides",
          translatedAt: today,
        },
      };
      warnings.push("pt-BR synopsis is a translation not yet reviewed");
    } else
      warnings.push("No official pt-BR synopsis; supply one in --overrides");
  }
  return {
    status: "OBSERVED",
    warnings,
    link: source.link,
    receipt: {
      version: 1,
      event_id: `${provider}-${source.key}`,
      batch_id: batch ?? `site-${today.replaceAll("-", "")}`,
      authorization: { site: true, reference: authorization },
      record,
      ...(provenance ? { provenance } : {}),
      destination: source.destination,
      verification: {
        status: "VERIFIED",
        adapter: `${provider}-observed`,
        bytes,
        md5,
        ...source.proof,
        evidence,
      },
    },
  };
}

export async function observeArchive(root, identifier, options = {}) {
  const { metadataOf = fetchMetadata, probe = remoteProbe } = options;
  requireValue(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(identifier ?? ""),
    "INVALID_ARCHIVE_IDENTIFIER"
  );
  requireValue(options.authorization?.trim(), "SITE_AUTHORIZATION_REQUIRED");
  const url = `https://archive.org/details/${identifier}`;
  const linked = allRecords(readDatabase(root)).find((film) =>
    film.external_links?.some((link) => link.url === url)
  );
  if (linked) return { status: "ALREADY_ON_SITE", id: linked.id };

  const item = await metadataOf(identifier);
  requireValue(
    item?.metadata?.identifier === identifier && !item.is_dark,
    "ARCHIVE_ITEM_NOT_PUBLIC"
  );
  const media = item.files.filter(
    (file) => file.source === "original" && MEDIA.test(file.name)
  );
  requireValue(media.length === 1, "EXACTLY_ONE_ORIGINAL_MEDIA_FILE_REQUIRED");
  const [file] = media,
    bytes = Number(file.size);
  const ffprobe = await probe(
    `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`
  );
  requireValue(
    Number(ffprobe?.format?.size) === bytes,
    "ARCHIVE_MEDIA_SIZE_MISMATCH"
  );
  return receiptFor(
    root,
    {
      provider: "archive",
      key: identifier,
      url,
      link: url,
      bytes,
      md5: file.md5,
      ffprobe,
      title: String(item.metadata.title ?? "")
        .replace(/\s*\(\d{4}\)$/, "")
        .trim(),
      creators: list(item.metadata.creator),
      year: Number(
        /\d{4}/.exec(item.metadata.year ?? item.metadata.date ?? "")?.[0]
      ),
      declared: list(item.metadata["external-identifier"])
        .map((value) => /^urn:tmdb:(\d+)$/.exec(value)?.[1])
        .filter(Boolean)
        .map(Number),
      evidence: { metadata: item },
      destination: { provider: "internet_archive", identifier },
    },
    options
  );
}

// `remote` is the film folder, laid out as <collection>/<Director>/<Title (Year)>.
export async function observeDrive(root, remote, options = {}) {
  const { remoteDrive = drive } = options;
  requireValue(options.authorization?.trim(), "SITE_AUTHORIZATION_REQUIRED");
  const path = String(remote ?? "").replace(/\/+$/, ""),
    parts = path.split("/"),
    named = /^(.+) \((\d{4})\)$/.exec(parts.at(-1) ?? "");
  requireValue(
    /^[^-:][^:]*:./.test(path) && parts.length >= 3 && named,
    "DRIVE_FILM_FOLDER_REQUIRED"
  );
  const parent = parts.slice(0, -1).join("/");
  const folders = (await remoteDrive.list(parent, "--dirs-only")).filter(
    (entry) => entry.Name === parts.at(-1)
  );
  requireValue(
    folders.length === 1 && /^[a-zA-Z0-9_-]+$/.test(folders[0].ID ?? ""),
    "DRIVE_FILM_FOLDER_NOT_FOUND"
  );
  const folderId = folders[0].ID,
    url = `https://drive.google.com/drive/folders/${folderId}`;
  const listing = await remoteDrive.list(path, "--files-only");
  const media = listing.filter((file) => MEDIA.test(file.Name));
  requireValue(media.length === 1, "EXACTLY_ONE_MEDIA_FILE_REQUIRED");
  const [file] = media;
  const ffprobe = await remoteDrive.probe(`${path}/${file.Name}`);
  const shared = await remoteDrive.opensAnonymously(url);
  return receiptFor(
    root,
    {
      provider: "drive",
      key: folderId,
      url,
      link: url,
      bytes: file.Size,
      md5: (file.Hashes?.md5 ?? file.Hashes?.MD5 ?? "").toLowerCase(),
      ffprobe,
      title: named[1],
      creators: parts.at(-2).split(/\s*(?:&|,| e | and )\s*/),
      year: Number(named[2]),
      declared: [],
      evidence: { listing: { folder: folders[0], files: listing } },
      warnings: shared
        ? []
        : ["Drive folder is not public; the ficha will have no Drive button"],
      destination: {
        provider: "google_drive",
        folder_id: folderId,
        is_film_folder: true,
        shared,
      },
      proof: shared
        ? { public_folder_id: folderId, permission: "anyone-reader" }
        : {},
    },
    options
  );
}
