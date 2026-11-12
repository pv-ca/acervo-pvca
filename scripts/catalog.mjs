import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog, mergeCatalog } from "./lib/catalog.mjs";

import { updateDatabase } from "./lib/store.mjs";
import { saveManual, publicRecords } from "./lib/database.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, inputPath, ...flags] = process.argv.slice(2);
try {
  if (
    !["check", "import"].includes(command) ||
    flags.some((flag) => flag !== "--replace") ||
    (flags.includes("--replace") && command !== "import")
  )
    throw new Error(
      "Uso: npm run catalog:check -- [arquivo.json] ou npm run catalog:import -- arquivo.json [--replace]"
    );
  if (command === "import" && !inputPath)
    throw new Error(
      "Informe o arquivo JSON com os registros públicos revisados."
    );
  const target = resolve(root, "data/public/catalog.json");
  const schema = JSON.parse(
    readFileSync(
      resolve(root, "data/schema/public-catalog.schema.json"),
      "utf8"
    )
  );
  const incoming = JSON.parse(
    readFileSync(inputPath ? resolve(inputPath) : target, "utf8")
  );
  const errors = validateCatalog(incoming, schema, resolve(root, "public"));
  if (errors.length) throw new Error(errors.join("\n"));
  if (command === "check") {
    if (!inputPath) {
      // Posters uploaded in the admin panel and never used would be published by `git add public/posters`.
      const used = new Set(incoming.map((film) => film.poster));
      const orphans = readdirSync(resolve(root, "public/posters")).filter(
        (file) =>
          /^poster-[0-9a-f]{24}\./.test(file) && !used.has(`/posters/${file}`)
      );
      if (orphans.length)
        throw new Error(
          `Pôster enviado pelo painel e não usado por nenhum filme: ${orphans.join(", ")}. Apague o arquivo ou aplique a ficha.`
        );
    }
    console.log(
      incoming.length
        ? `${incoming.length} registro(s) válido(s). Nenhuma alteração feita.`
        : "Catálogo real vazio. A prévia de desenvolvimento continua ativa."
    );
  } else {
    if (!incoming.length)
      throw new Error("Entrada vazia: nenhum filme foi alterado.");
    let merged;
    updateDatabase(root, (db) => {
      merged = mergeCatalog(
        publicRecords(db),
        incoming,
        flags.includes("--replace")
      );
      const errors = validateCatalog(merged, schema, resolve(root, "public"));
      if (errors.length) throw Error(errors.join("\n"));
      for (const film of incoming) db = saveManual(db, film, true);
      return db;
    });
    console.log(
      `${incoming.length} registro(s) importado(s) localmente. Total: ${merged.length}. Rode npm run build e revise. Nenhum commit, upload ou publicação realizado.`
    );
  }
} catch (error) {
  // Do not print raw JSON parse errors: they can include private source content.
  console.error(
    error instanceof SyntaxError
      ? "JSON inválido. Corrija a estrutura do arquivo antes de importar."
      : error.message
  );
  process.exitCode = 1;
}
