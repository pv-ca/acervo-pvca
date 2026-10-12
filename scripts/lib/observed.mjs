import { convertCanonical } from "./canonical.mjs";

// Only the selected, remotely observed copy enters the public projection.
export function convertObserved(input, audit, { shareDrive = false } = {}) {
  if (
    input?.schema_version !== "pvca-clean-catalog-6.2-subset" ||
    audit?.schema_version !== "pvca-remote-technical-observation-1" ||
    !Array.isArray(input.items) ||
    input.item_count !== input.items.length ||
    !Array.isArray(audit.observations)
  )
    throw Error("Formato ou contagem da auditoria inválidos.");
  const observations = new Map();
  for (const observation of audit.observations) {
    if (observations.has(observation.pvca_id))
      throw Error("Observação duplicada.");
    observations.set(observation.pvca_id, observation);
  }
  const projected = [];
  for (const item of input.items) {
    const observation = observations.get(item.pvca_id),
      copy = observation?.observed_copy;
    const provider = copy?.source?.toLowerCase();
    if (
      !observation ||
      observation.title !== item.title ||
      observation.year !== item.year ||
      provider !== item.availability?.preferred_media_source?.toLowerCase() ||
      item.copies?.[provider]?.url !== copy.source_url
    )
      throw Error(`Identidade ou cópia inconsistente: ${item.pvca_id}`);
    if (
      !Number.isSafeInteger(copy.size_bytes) ||
      copy.size_bytes <= 0 ||
      !Array.isArray(copy.ffprobe?.streams)
    )
      throw Error(`Evidência técnica ausente: ${item.pvca_id}`);
    const videos = copy.ffprobe.streams.filter(
      (s) => s.codec_type === "video" && !s.disposition?.attached_pic
    );
    if (
      videos.length !== 1 ||
      !Number.isInteger(videos[0].width) ||
      !Number.isInteger(videos[0].height)
    )
      throw Error(`Vídeo ambíguo: ${item.pvca_id}`);
    const probeFormat = copy.ffprobe.format?.format_name || "";
    const format = probeFormat.includes("matroska")
      ? "MKV"
      : probeFormat.includes("mp4")
        ? "MP4"
        : probeFormat === "avi"
          ? "AVI"
          : null;
    const declared = item.copies[provider].resolution?.declared_class;
    const subtitles = copy.ffprobe.streams
      .filter((s) => s.codec_type === "subtitle")
      .map((stream) => {
        let tag = stream.tags?.language;
        const title = (stream.tags?.title || "")
          .normalize("NFKD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase();
        if (["por", "pt", "pt-BR", "pt-br"].includes(tag)) {
          if (/portugal|iberian/.test(title)) tag = "pt-pt";
          else if (/brasil|brazil|brasileir/.test(title)) tag = "pt-br";
        }
        return { language: { tag } };
      });
    projected.push({
      pvca_id: item.pvca_id,
      title: item.title,
      year: item.year,
      identity: item.identity,
      metadata: item.metadata,
      availability: { preferred_media_source: copy.source },
      media: { source: copy.source },
      copies: {
        [provider]: {
          status: "AVAILABLE",
          url: copy.source_url,
          size: { bytes: copy.size_bytes },
          resolution: {
            declared_class: declared,
            label: `${videos[0].width}×${videos[0].height}`,
          },
          container: { value: format },
          technical: {
            audio_streams: copy.ffprobe.streams
              .filter((s) => s.codec_type === "audio")
              .map((s) => ({ tags: { language: s.tags?.language } })),
          },
          embedded_subtitles: { tracks: subtitles },
        },
      },
    });
  }
  const result = convertCanonical({
    schema_version: "pvca-clean-catalog-6.1",
    item_count: projected.length,
    items: projected,
  });
  for (const record of result.records) {
    const item = input.items.find((i) => i.pvca_id === record.id),
      provider = item.availability.preferred_media_source.toLowerCase();
    if (shareDrive && provider === "drive")
      record.external_links.push({
        provider: "google_drive",
        url: item.copies.drive.url,
        copy_id: record.catalog_copy_id,
      });
  }
  return result;
}
