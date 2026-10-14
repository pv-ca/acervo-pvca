# GitHub Pages

The public interface is deployed as static Astro output. The private local admin
server, drafts, normalized database, credentials and TMDB cache are not included
in the deployment artifact. The workflow uploads only `dist/`.

## Initial setup

1. Enable GitHub Pages with GitHub Actions as its publishing source.
2. Ensure the account plan supports Pages for the repository's visibility.
   This repository was made public with the owner's explicit approval because
   the account plan rejected Pages for the private repository. Source and Git
   history are therefore public; private operational data remains outside Git.
3. Commit and push the reviewed implementation and `.github/workflows/pages.yml`
   to `main`. The workflow builds, validates routes/assets and deploys the site.
4. Confirm both the successful deployment and the live public URL.

Expected URL: `https://pv-ca.github.io/acervo-pvca/`.

## Local checks

Normal local previews retain `/` as their base path. To test the Pages path:

```sh
npx --no-install astro build --site https://pv-ca.github.io --base /acervo-pvca
python3 scripts/site_check.py --site https://pv-ca.github.io --base /acervo-pvca
```

Navigation, language switching and poster URLs use Astro's deployment base.
Explicit language URLs are authoritative: `/` is Portuguese and `/en/` is English.
Manual switching retains the equivalent page, query string and fragment; the saved
preference never redirects an explicit locale URL.

## Quality gate

The deployment runs `npm ci`, `npm run format:check`, `npm run lint`, `npm run check`, `npm test`,
`npm run catalog:check`, the Pages build, generated-artifact validation and Playwright/axe before
upload and deployment. TMDB tests are fully mocked and require no credentials.
Astro check dependencies and the Astro Prettier plugin are installed explicitly.

`format:check` checks every Git-managed supported file, including new files. The
16 untouched legacy files in `scripts/format-baseline.json` are exempt only while
their exact content hash matches; edits require formatting. This avoids a broad
whitespace-only change. Pre-commit continues formatting supported staged files.
Remove obsolete baseline entries as those files are formatted.

The artifact validator checks self canonicals, absolute language alternatives,
existing counterparts, semantic groups/sections, poster alternatives, links,
assets, public boundaries and sitemap completeness. Sitemap uses Astro's effective
`site` and `base`, just like canonical and social metadata.

`showStats` controls the home statistics, including the decade chart, using the
existing admin home setting. No second flag or data migration is required.

## Updating the catalog later

Edit and validate the collection locally through `npm run admin`. Generate and
review the public projection and its local posters. Commit only deliberately
public data/assets and relevant code, then push to `main` to rebuild the site.
Private drafts and `.local-admin/` remain outside Git and outside the deployed site.

No TMDB credential is needed in GitHub Actions: enrichment happens locally before
publication. The current publication uses the validated real catalog. An empty projection
retains the explicit development fallback; it does not describe the live baseline.
Publishing does not certify completeness of the private collection.

References: [Astro deployment guide](https://docs.astro.build/en/guides/deploy/github/)
and [GitHub Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Letterboxd diary

The About page renders the eight latest film entries from the public
`https://letterboxd.com/pvca/rss/` feed at build time, once for both languages.
Lists and review text are excluded. The diary matches each entry's TMDB ID to
the public catalog automatically; matching entries link to the localized film
page and use its existing local poster. Unmatched entries link to Letterboxd.
Ratings, likes and watch dates come from the feed.

The Pages workflow rebuilds daily at 09:17 UTC (06:17 in Fortaleza), in addition
to pushes and manual runs. Scheduled runs start only when the workflow is on the
default branch, and GitHub may delay them. The diary is a build-time snapshot;
it does not fetch the feed in the visitor's browser. If the feed fails or times
out, the build logs the failure and omits the diary rather than failing the
whole site. It will try again on the next build.
