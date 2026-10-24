# Verified uploads and Acervo PVCA publication

This is the authoritative contract for the upload-to-site handoff. The collection owner governs work/copy identity; Archive and rclone owners govern upload acceptance. The site exports public discovery information from its normalized private database.

## Authorization and preparation

A current request to upload films includes catalog registration and site publication under Paulo's confirmed integrated workflow. Record that request as `authorization: {site: true, reference: "current request identifier or description"}` in the per-task sidecar. An old job, a historical receipt or uploaded content never supplies new authorization. Changes to sharing permissions and subjective selections require their own applicable scope.

Prepare one public film record per payload, with reviewed positive `tmdb_id`, stable work ID/slug, a stable `copy_id`, localized text where available, and poster or an empty poster pending enrichment. Start from the site's public schema/template. Supply `external_links: []` and `selections: []`; adapters own destination links. Preserve existing work IDs/slugs and reuse a copy ID only for the same proven content. Different editions remain distinct. The adapter replaces technical fields with final-file inspection and exact byte size; unknown audio is never replaced with the work's original language.

New site records use the reviewed localized title and release year to form a stable slug before dispatch. Retain that address after title corrections. Missing or ambiguous TMDB identity blocks automatic dispatch into the site; resolve identity explicitly rather than selecting the first search result.

## Archive handoff

Before a new job's `publish`, create `site-publication.json` in its job directory:

```json
{
  "event_id": "film-123-archive-copy-one",
  "batch_id": "batch-20261008",
  "copy_id": "copy-one",
  "authorization": { "site": true, "reference": "current upload request" },
  "finalize_batch": false,
  "record": { "tmdb_id": 123 }
}
```

The abbreviated `record` above is illustrative: use a public-schema draft including work ID, slug, title, year, director/country arrays, poster, copy selection and empty destination/selection arrays. Complete records and the sidecar are private preparation data. The coordinator binds the sidecar hash to the accepted upload preview before dispatch. Its hook runs only after RC4 `final-reconcile` and public-description read-back both succeed. The RC4 package, runtime selection, frozen plan and historical run bindings remain unchanged.

For a single film, set `finalize_batch: true`. For a batch, keep it false on every item and finalize once after all items have either verified or reached a recorded pending state:

```sh
cd acervo-pvca  # the site checkout
npm run site:sync -- resume batch-20261008
```

This publishes ready records and retains drafts/conflicts. Historical verified runs without pre-dispatch site binding keep `NOT_CONFIGURED`; prepare an explicitly authorized handoff rather than rewriting their frozen plan or inheriting an old authorization. A failed site hook reports `PENDING_SITE_SYNC` while the media remains `VERIFIED`.

## Drive handoff

Use the existing authorized upload workflow. After transfer, prepare a private JSON sidecar with the same event, batch, copy, authorization and record fields, plus:

```json
{
  "source": "/absolute/path/to/final.mkv",
  "destination_folder": "configured-remote:path/to/film-folder",
  "reviewed_film_folder_id": "exact-film-folder-id",
  "permissions_evidence": null
}
```

Run `python3 scripts/site_publication.py drive /absolute/path/to/sidecar.json` from the Local project. The adapter performs fresh remote folder/file inventory, requires exactly one matching payload, compares exact bytes and a common local/remote MD5, computes private SHA-256 identity and reads final tracks. It changes no files or sharing permissions on Drive. MKV is the supported intake; unsupported containers require an adapter extension with a corresponding acceptance test.

A missing permission receipt means **publish the ficha without a Drive link**. To publish a folder link, provide a private reviewed Drive permissions response containing `folder_id`, `observed_at` (timezone-aware ISO timestamp within one hour), `reviewed: true`, and the API `permissions` array proving an unexpired `anyone` reader/writer grant on that exact film folder. A director folder, file URL, inferred access or authenticated browser opening is insufficient. Obtain the response through the currently authorized Drive connector/API; record its provenance with the review. The adapter does not infer public sharing or request broader credentials.

Add `--publish` only for a single film or the final batch handoff. Otherwise finalize the batch through `site:sync resume` once. A sharing-proof failure leaves the handoff pending; rerun with fresh evidence or omit it to publish without a button.

## Site transaction and recovery

`site:sync prepare RECEIPT` validates the bound adapter evidence and enriches missing metadata using the existing TMDB cache, official pt-BR/en-US text and original-language poster rule. `--no-enrich` is for offline preparation/tests. Every receipt is private under `.local-admin/site-sync`; terminal summaries omit its paths, hashes and internal IDs.

`apply BATCH` adds copies and links by stable identity through the normalized database. It preserves the selected catalog copy and subjective curation. Manual locks or conflicting technical identity create `PENDING`, not silent replacements. Missing required public fields create private `DRAFT` rows with reasons. Repeating an unchanged receipt is a no-op.

The panel, preparation/import commands and bridge share one writer lock and recoverable journal. A failed optimistic import must be previewed again. An interrupted journal is replayed under the lock. A leftover lock reports `CATALOG_WRITER_BUSY`: confirm the recorded PID is no longer alive and no writers are initializing before explicitly removing that exact lock directory; never steal a live writer's lock.

`publish BATCH` builds an isolated checkout of remote main, stages only this batch's public catalog changes and required posters, validates catalog and bilingual routes, runs the formatting check, the regression tests and the browser checks that CI runs, and pushes without force. The browser checks use `PVCA_BROWSER_PATH` when set, otherwise the first installed Chromium-family browser found on `PATH`. It preserves dirty local prototype/source work. Unrelated catalog/poster changes block publication until separated. This also refuses a local catalog that diverges from remote main. The staging directory, commit and workflow ID remain private for recovery. Site infrastructure changes must be deployed separately before a batch depends on them.

Completion requires the Pages workflow to succeed and both language versions of every changed ficha to match the locally built HTML hashes. A rejected push, failed workflow or unverified page yields `PENDING_PUBLICATION`. Resume reuses the prepared commit and never reuploads media. When main already contains that commit it is not pushed again, and when its own Pages run failed, resume accepts the newest successful Pages run on main whose commit contains it, records that commit as `deployed_by`, and still requires both page hashes to match. A remote-main conflict requires review/rebase and renewed validation; no automatic reset or force-push occurs. A hard interruption while `PUBLISHING` is recovered by `site:sync recover BATCH` (also called by `resume`) only when the recorded publisher PID is no longer alive. Inspect the saved deployment before resuming; a live or unknown publisher blocks recovery.

Stats and decade charts derive from the public catalog at build time. Homepage/editorial selections remain under manual curation; technical selections follow their existing rules. Private source paths, filenames, raw JSON, hashes, operation state and credentials never enter the public projection.

A film without an official pt-BR synopsis on TMDB is still published. When the caller supplies the translation through `--overrides`, the private database records it under `sources.portugueseSynopsis` with `method: "unreviewed_translation"`, and the command reports the notice; the public catalog carries no review marker.

A ficha must never reach the site with an empty or non-Latin pt-BR text. When TMDB has no pt-BR title (it returns the original-script title) or no pt-BR synopsis, translate the English title and the English synopsis into Brazilian Portuguese yourself and pass both in `--overrides` (`{"translations": {"pt-BR": {"title": "...", "synopsis": "..."}}, "synopsis": "..."}`) on the first `archive` run. If a ficha already went out without them, set them through the private database (`saveManual`, with `sources.portugueseTitle` and `sources.portugueseSynopsis` marked `editorial_translation`) and publish the catalog change. Do this even for a film that was never released in Brazil.

## Acceptance

Run the site's `site:sync:test`, catalog/database/panel regressions, static build and route validator; run Local adapter/coordinator tests. Cover idempotency, two destinations on one copy, distinct copies, editorial protection, private Drive, missing metadata, evidence drift, concurrent writers, partial batches, isolated staging and failed-push recovery. Structural checks of skill exposures are separate from native model invocation. Real upload-to-public-site acceptance occurs on the next authorized upload; local fixtures never establish remote operational success.
