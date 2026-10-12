// Letterboxd import export: one row per catalog film. The Review links to the
// film's ficha, which always shows the current copies, and describes the best
// public copy (size, resolution, subtitles).
const SITE = "https://pv-ca.github.io/acervo-pvca";
const LINK_TEXT = "Ver a ficha do filme no Acervo PVCA";
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
  const anchor = `<a href="${SITE}/filmes/${film.slug}/">${LINK_TEXT}</a>`;
  const copy = publicCopy(film);
  if (!copy) return anchor;
  const subtitles = formatSubtitles(copy.subtitle_languages ?? []);
  const meta = [
    formatSize(copy.size_gib),
    formatResolution(copy.resolution),
    subtitles && `Legendas: ${subtitles}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${anchor}<br>${meta}`;
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
