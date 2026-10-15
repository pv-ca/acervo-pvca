import { resolve } from "node:path";
import editorial from "../../data/public/editorial.json";
import publicCatalog from "../../data/public/catalog.json";
import schema from "../../data/schema/public-catalog.schema.json";
import { validateCatalog, toRuntimeFilm } from "../../scripts/lib/catalog.mjs";
import { catalogPreview, type CatalogPreviewFilm } from "./catalog-preview";

const errors = validateCatalog(publicCatalog, schema, resolve("public"));
if (errors.length)
  throw new Error(`Invalid public catalog:\n${errors.join("\n")}`);
export const isPreview =
  publicCatalog.length === 0 && editorial.previewRecentSlugs.length > 0;
export const catalog: CatalogPreviewFilm[] = isPreview
  ? catalogPreview
  : publicCatalog.map(toRuntimeFilm);
