#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  prepare,
  apply,
  status,
  read,
  recoverBatch,
} from "./lib/site-sync.mjs";
import { publish } from "./lib/site-deploy.mjs";
import { observeArchive, observeDrive } from "./lib/archive-observed.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const [action, ...args] = process.argv.slice(2);
const batch = args[0];
try {
  let result;
  if (action === "prepare") {
    if (!args[0] || args.slice(1).some((a) => a !== "--no-enrich"))
      throw Error("prepare RECEIPT [--no-enrich]");
    result = await prepare(root, read(resolve(args[0])), {
      enrich: !args.includes("--no-enrich"),
    });
  } else if (action === "archive" || action === "drive") {
    // Options are --name value pairs after the identifier.
    const options = Object.fromEntries(
      args
        .slice(1)
        .flatMap((arg, i, all) =>
          i % 2 ? [] : [[arg.replace(/^--/, ""), all[i + 1]]]
        )
    );
    if (
      !args[0] ||
      Object.keys(options).some(
        (name) =>
          !["tmdb", "authorized", "overrides", "batch", "replace"].includes(
            name
          )
      )
    )
      throw Error(
        "archive IDENTIFIER | drive REMOTE_FILM_FOLDER, then --authorized REFERENCE [--tmdb ID] [--overrides FILE] [--batch BATCH] [--replace 1]"
      );
    const observed = await (
      action === "archive" ? observeArchive : observeDrive
    )(root, args[0], {
      tmdbId: options.tmdb ? Number(options.tmdb) : undefined,
      authorization: options.authorized,
      batch: options.batch,
      replace: options.replace === "1",
      overrides: options.overrides ? read(resolve(options.overrides)) : {},
    });
    if (observed.status === "ALREADY_ON_SITE") result = observed;
    else {
      await prepare(root, observed.receipt);
      result = apply(root, observed.receipt.batch_id);
      result.warnings = observed.warnings;
      result.link = observed.link;
    }
  } else if (action === "status") result = status(root, batch);
  else if (action === "recover") result = recoverBatch(root, batch);
  else if (action === "apply") result = apply(root, batch);
  else if (action === "publish") result = await publish(root, batch);
  else if (action === "resume") {
    recoverBatch(root, batch);
    apply(root, batch);
    result = await publish(root, batch);
  } else
    throw Error(
      "Use archive IDENTIFIER | drive REMOTE_FILM_FOLDER | prepare RECEIPT | apply BATCH | publish BATCH | status BATCH | recover BATCH | resume BATCH"
    );
  // Private receipts stay on disk; console output is a compact operational summary.
  console.log(
    JSON.stringify(
      {
        status: result.status,
        id: result.id,
        warnings: result.warnings,
        link: result.link,
        batch_id: result.batch_id,
        events: Object.entries(result.events ?? {}).map(([id, e]) => ({
          id,
          status: e.status,
          reasons: e.result?.reasons,
          error: e.error,
        })),
        error: result.error,
        commit: result.deployment?.commit,
        workflow: result.deployment?.workflow_id,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    error instanceof SyntaxError ? "INVALID_JSON_RECEIPT" : error.message
  );
  process.exitCode = 1;
}
