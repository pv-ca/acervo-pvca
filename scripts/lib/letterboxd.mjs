// Letterboxd import export: one row per catalog film. The Review links to the
// film's public copies (Google Drive, then Internet Archive) and describes the
// best one (size, resolution, subtitles of each source).
export const SITE = "https://pv-ca.github.io/acervo-pvca";
// A film with no public copy has nothing to link: its link names the ficha only.
const FICHA = "Ficha no Acervo PVCA";
// Display order of the sources: [catalog provider, link text, subtitle label].
const SOURCES = [
  ["google_drive", "Google Drive", "Drive"],
  ["internet_archive", "Internet Archive", "Archive"],
];
const BYTES_PER_GIB = 1.073741824;
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

// The largest copy that has a current public link; a private or pending copy is never described.
function publicCopy(film) {
  const linked = new Set(
    (film.external_links ?? []).map((link) => link.copy_id)
  );
  return (film.copies ?? [])
    .filter((copy) => linked.has(copy.id))
    .sort((a, b) => b.size_gib - a.size_gib)[0];
}

export function reviewFor(film) {
  const copy = publicCopy(film);
  const sources = SOURCES.flatMap(([provider, name, label]) => {
    const links = (film.external_links ?? []).filter(
      (l) => l.provider === provider
    );
    // The link of the copy the note describes; another link of the same source would show a different file.
    const link = links.find((l) => l.copy_id === copy?.id) ?? links[0];
    return link ? [{ link, name, label }] : [];
  });
  if (!sources.length)
    return `<a href="${SITE}/filmes/${film.slug}/">${FICHA}</a>`;
  const anchors = sources
    .map(({ link, name }) => `<a href="${link.url}">${name}</a>`)
    .join(" · ");
  if (!copy) return anchors;
  // Each source lists the subtitles of its own copy; with one source the label adds nothing.
  const subtitles = sources
    .map(({ link, label }) => [
      label,
      formatSubtitles(
        film.copies.find((c) => c.id === link.copy_id)?.subtitle_languages ?? []
      ),
    ])
    .filter(([, list]) => list);
  const legend =
    sources.length > 1
      ? subtitles.map(([label, list]) => `${list} (${label})`).join(" / ")
      : subtitles[0]?.[1];
  const meta = [
    formatSize(copy.size_gib),
    formatResolution(copy.resolution),
    legend && `Legendas: ${legend}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${anchors}<br>${meta}`;
}

const quote = (value) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

// One row per catalog film, whatever its identity or availability: the catalog
// alone defines what is exported. uris maps tmdb_id to the film's
// letterboxd.com URI and only adds identity; tmdbID lets Letterboxd match the
// films whose URI is not known.
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
