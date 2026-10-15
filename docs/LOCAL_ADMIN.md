# Private local editor

Start from the project root:

```sh
npm run admin
```

Open `http://127.0.0.1:4323/`. The editor listens only on IPv4 loopback, enforces
its Host/Origin and a per-process write token, and does not enable CORS. It is
intended for a trusted local user, not internet hosting. Do not bind it to a
network interface, expose it through a proxy or deploy it as a public `/admin`.

The editor code lives under `scripts/admin/`, outside Astro's generated routes.
No admin link, script, draft data or editing API is included in the static site.
No login or backend is added to the visitor site. No new dependency is installed.

## Preview

The editor's **Gerar prévia** runs the existing Astro build locally. Start the
read-only preview server separately when needed:

```sh
npm run preview -- --host 127.0.0.1 --port 4322
```

The **Abrir prévia** destination uses this address. Changes are saved locally,
then compiled for review; no upload, commit, push or deployment happens.

## Data ownership

- `data/public/editorial.json`: featured film/note, recent count, home selection
  visibility/order, stats visibility and selection definitions/rules.
- `data/public/catalog.json`: validated final film records. The panel uses the
  same schema and cross-reference validator as the CLI and build.
- `data/public/catalog.preview.json`: existing preview metadata extracted from
  TypeScript without adding facts. Used only when the real source is empty.
- `.local-admin/drafts.json`: incomplete, uncommitted draft forms; excluded from
  Git and static output. Do not put operational secrets in any form.
- `.local-admin/backups/`: automatic copies of data before panel writes. New admin transactions
  include the private database, editorial definitions and drafts; retain the
  complete bundle when recovering linked edits.
  Review the dated backup and restore the chosen JSON locally if recovery is
  needed; do not silently overwrite subsequent edits.

`added_at` stores a confirmed catalog entry date in ISO `YYYY-MM-DD` form. New
forms initially propose today's date; the owner can correct it before applying.
Missing dates stay missing. Recent entries sort by date descending, then title
for ties. Edits preserve existing dates; chronology is not inferred from import
array order, release year, poster, file size or a service URL.

Manual selections use explicitly chosen film slugs and matching declared catalog
membership. Saving selection definitions reconciles those titles in final film
records; removing a selection preserves the films. Preview membership is driven
by the editable definitions. Automatic pt-BR/4K rules use the selected copy.
Create an editorial definition before expecting a new imported selection title
to have a public entry. Home selection order follows `homeSelectionIds`.

The panel writes complete validated film records, preserving identity. It supports recoverable film removal through **Excluir ficha**. Removed records
are stored in the private database and can be restored from **Excluídas**. Removal
reconciles selection and featured-film references in the same recoverable
transaction. Poster files and media are preserved; no media is downloaded. Uploaded
poster files receive unique names and basic image-signature checks; their visual
correctness and provenance still require the owner's review.

## Checks

```sh
npm run admin:test
npm run catalog:test
npm run build
git diff --check
```

Admin tests use temporary data and a loopback listener. Catalog tests include
an isolated static build. Neither test imports a film into the real project.
Verify controls in the browser as well; HTTP tests do not prove visual usability.

## Navigation and concurrent edits

The default film gallery supports title, director and year search, with separate
filters for catalog records, drafts and removed records. The detail editor groups
identity, editorial text/poster, copies and links. Unsaved forms require an explicit
discard decision before switching editors.

**Seleções** supports creating, editing and deleting manual or automatic selections.
Manual membership offers search and a selected-only view. Deleting a selection
preserves films and removes its home reference. Existing-record saves and editorial
saves reject stale versions sent by another open browser window.
