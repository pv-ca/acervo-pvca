// Letterboxd import export: one row per catalog film, in the Review format of
// the curated acervo_pvca_letterboxd_import CSVs (links, size, resolution, subtitles).
const PROVIDERS = [
  ["google_drive", "Google Drive", "Drive"],
  ["internet_archive", "Internet Archive", "Archive"],
];
const BYTES_PER_GIB = 1.073741824;
const SAME_SIZE = 0.01;
const LANGUAGE_CODES = {
  may: "MS",
  mac: "MK",
  rom: "RO",
  nob: "NO",
  kaz: "KK",
};

export function formatSize(gib) {
  const gb = gib * BYTES_PER_GIB;
  return gb >= 1
    ? `${gb.toFixed(1).replace(".", ",")} GB`
    : `${Math.round(gb * 1000)} MB`;
}

export function formatResolution(value) {
  const size = /^\d+×(\d+)$/.exec(value);
  return size ? `${size[1]}p` : value;
}

export function formatSubtitles(languages) {
  const codes = languages.map((code) =>
    (LANGUAGE_CODES[code] ?? code).toUpperCase()
  );
  return [
    ...codes.filter((code) => code === "PT-BR"),
    ...codes.filter((code) => code !== "PT-BR"),
  ].join(", ");
}

// Joins one value per link: a single value when the copies agree, otherwise
// "value (Drive) / value (Archive)". Copies without a value are left out.
function merge(entries, same = (a, b) => a === b) {
  const present = entries.filter((entry) => entry.value);
  if (!present.length) return "";
  const [first, ...rest] = present;
  if (rest.every((entry) => same(first.value, entry.value)))
    return present.length === entries.length
      ? present.at(-1).value
      : `${present.at(-1).value} (${present.at(-1).label})`;
  return present.map((entry) => `${entry.value} (${entry.label})`).join(" / ");
}

// Only copies with a current public link are described: a Review states
// verifiable access, never a private or pending copy.
function sourcesFor(film) {
  return PROVIDERS.flatMap(([provider, name, label]) => {
    const link = film.external_links?.find(
      (item) => item.provider === provider
    );
    const copy = film.copies?.find((item) => item.id === link?.copy_id);
    return link && copy ? [{ link, name, label, copy }] : [];
  });
}

export function reviewFor(film) {
  const links = sourcesFor(film);
  if (!links.length) return "";
  const anchors = links
    .map(({ link, name }) => `<a href="${link.url}">${name}</a>`)
    .join(" · ");
  const sizes = links.map(({ label, copy }) => ({
    label,
    value: formatSize(copy.size_gib),
    gib: copy.size_gib,
  }));
  const sameSize =
    Math.max(...sizes.map((s) => s.gib)) -
      Math.min(...sizes.map((s) => s.gib)) <=
    SAME_SIZE * Math.max(...sizes.map((s) => s.gib));
  const parts = [
    sameSize ? sizes.at(-1).value : merge(sizes),
    merge(
      links.map(({ label, copy }) => ({
        label,
        value: formatResolution(copy.resolution),
      }))
    ),
    merge(
      links.map(({ label, copy }) => ({
        label,
        value: formatSubtitles(copy.subtitle_languages ?? []),
      }))
    ),
  ];
  const meta = [parts[0], parts[1], parts[2] && `Legendas: ${parts[2]}`]
    .filter(Boolean)
    .join(" · ");
  return `${anchors}<br>${meta}`;
}

const quote = (value) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

// One row per catalog film, whatever its identity or availability: the catalog
// alone defines what is exported. uris maps tmdb_id to the film's
// letterboxd.com URI and only adds identity; tmdbID lets Letterboxd match the
// films whose URI is not known. A film with no public copy has an empty Review.
export function letterboxdCsv(films, uris = {}) {
  const rows = films.map((film) =>
    [uris[film.tmdb_id] ?? "", film.tmdb_id ?? "", reviewFor(film)]
      .map((value) => quote(String(value)))
      .join(",")
  );
  return {
    count: rows.length,
    csv:
      "\ufeff" + ["LetterboxdURI,tmdbID,Review", ...rows].join("\r\n") + "\r\n",
  };
}

export function letterboxdFilename(count, date = new Date()) {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `Acervo PVCA — Catálogo Mestre — ${count} títulos — ${day}.csv`;
}
