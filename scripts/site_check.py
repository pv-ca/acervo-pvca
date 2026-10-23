"""Validate generated bilingual routes, metadata, accessibility and public boundaries."""
from argparse import ArgumentParser
from html.parser import HTMLParser
from pathlib import Path
import json
import re
from urllib.parse import urlsplit, unquote, urljoin
import xml.etree.ElementTree as ET


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = []
        self.assets = []
        self.lang = None
        self.text = []
        self.skip = False
        self.canonicals = []
        self.alternates = {}
        self.semantic_errors = []
        self.sections = []
        self.anchors = []
        self.chart = False
        self.chart_counts = []
        self.count_depth = 0
        self.card_count = 0
        self.noindex = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get('class', '').split()
        if tag == 'meta' and attrs.get('name') == 'robots' and 'noindex' in attrs.get('content', ''):
            self.noindex = True
        if tag == 'html':
            self.lang = attrs.get('lang')
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        if tag in ('div', 'span') and any(key in attrs for key in ('aria-label', 'aria-labelledby')):
            # Only naming-supported roles are accepted on otherwise generic containers.
            if attrs.get('role') not in ('group', 'img', 'region', 'navigation', 'status', 'alert', 'dialog', 'search', 'list', 'listitem'):
                self.semantic_errors.append(f'{tag}: accessible name on a generic element')
        if tag == 'section':
            self.sections.append(bool(attrs.get('aria-label') or attrs.get('aria-labelledby')))
        if re.fullmatch(r'h[1-6]', tag):
            self.sections = [True for _ in self.sections]
            for anchor in self.anchors:
                anchor['heading'] = True
        if tag == 'a':
            if 'href' in attrs:
                self.links.append(attrs['href'])
            self.anchors.append({'heading': False, 'posters': []})
            if 'film-card' in classes:
                self.card_count += 1
        if tag == 'img':
            if 'alt' not in attrs:
                self.semantic_errors.append('img: missing alt')
            if 'poster' in classes and self.anchors:
                self.anchors[-1]['posters'].append(attrs.get('alt', ''))
        if tag in ('img', 'script') and 'src' in attrs:
            self.assets.append(attrs['src'])
        if tag == 'link':
            rel = attrs.get('rel')
            if rel in ('stylesheet', 'modulepreload', 'icon'):
                self.assets.append(attrs['href'])
            if rel == 'canonical':
                self.canonicals.append(attrs.get('href', ''))
            if rel == 'alternate' and attrs.get('hreflang'):
                self.alternates.setdefault(attrs['hreflang'], []).append(attrs.get('href', ''))
        if 'decade-chart' in classes:
            self.chart = True
        if self.chart and tag == 'span':
            if 'count' in classes:
                self.count_depth = 1
            elif self.count_depth:
                self.count_depth += 1
        if tag in ('script', 'style'):
            self.skip = True

    def handle_endtag(self, tag):
        if tag == 'section' and self.sections:
            if not self.sections.pop():
                self.semantic_errors.append('section: missing heading or accessible name')
        if tag == 'a' and self.anchors:
            anchor = self.anchors.pop()
            if anchor['heading'] and any(anchor['posters']):
                self.semantic_errors.append('poster: redundant alt in a link with a heading')
        if tag == 'span' and self.count_depth:
            self.count_depth -= 1
        if tag in ('script', 'style'):
            self.skip = False

    def handle_data(self, text):
        if not self.skip:
            self.text.append(text)
        if self.count_depth == 1 and text.strip().isdigit():
            self.chart_counts.append(int(text.strip()))


def metadata_errors(page, route, pages, site, prefix):
    errors = []
    expected = urljoin(site, prefix + route)
    if page.canonicals != [expected]:
        errors.append('canonical must be absolute and point to this locale')
    counterpart = '/en/404/' if route == '/404.html' else '/404.html' if route == '/en/404/' else route.removeprefix('/en') if route.startswith('/en/') else '/en' + route
    if counterpart not in pages:
        errors.append('missing translation counterpart')
    targets = [('pt-BR', '/404.html'), ('en', '/en/404/')] if route in ('/404.html', '/en/404/') else [('pt-BR', route.removeprefix('/en') if route.startswith('/en/') else route), ('en', route if route.startswith('/en/') else '/en' + route)]
    for lang, target in targets:
        if page.alternates.get(lang) != [urljoin(site, prefix + target)]:
            errors.append(f'{lang}: alternate must be absolute and point to the equivalent page')
    return errors


def validate(root, base, site):
    prefix = base.rstrip('/')
    pages = {}
    errors = []
    links = assets = 0
    for file in root.rglob('*.html'):
        page = Page()
        page.feed(file.read_text())
        pages['/' + str(file.relative_to(root)).removesuffix('index.html')] = page

    def local_path(href, route):
        url = urlsplit(href)
        if url.scheme or url.netloc:
            if (url.scheme, url.netloc) != (urlsplit(site).scheme, urlsplit(site).netloc):
                return None, None
        target = unquote(urlsplit(urljoin(prefix + route, url.path)).path)
        if prefix and not target.startswith(prefix + '/'):
            errors.append(f'{route}: URL outside deployment base: {href}')
            return None, None
        return target[len(prefix):] or '/', url.fragment

    for route, page in pages.items():
        expected = 'en' if route.startswith('/en/') else 'pt-BR'
        if page.lang != expected:
            errors.append(f'{route}: wrong language')
        if '/admin/' in route:
            errors.append('Admin route exposed')
        for error in metadata_errors(page, route, pages, site, prefix) + page.semantic_errors:
            errors.append(f'{route}: {error}')
        for phrase in ['Não há acesso público', 'Somente no acervo', 'Disponíveis no Internet Archive', 'Painel local']:
            if phrase in ''.join(page.text):
                errors.append(f'{route}: forbidden public text')
        for href in page.links:
            target, fragment = local_path(href, route)
            if target is None:
                continue
            if not target.endswith('/') and not target.endswith('.html'):
                target += '/'
            if target not in pages:
                errors.append(f'{route}: broken link {href}')
            elif fragment and unquote(fragment) not in pages[target].ids:
                errors.append(f'{route}: missing anchor {href}')
            links += 1
        for href in page.assets:
            target, _ = local_path(href, route)
            if target is not None:
                if not (root / target.lstrip('/')).is_file():
                    errors.append(f'{route}: missing asset {href}')
                assets += 1

    # Inspect output only, never private inputs. Report the file, not a potential secret.
    private_pattern = re.compile(r'(?:/home/|/mnt/|/media/|data/private/|\b[0-9a-f]{64}\b|Bearer\s+[A-Za-z0-9._-]+|(?:local_path|mount_path|sha256|operational_hash|api_key|access_token)\s*["\x27]?\s*:)')
    for file in root.rglob('*'):
        if file.is_file() and file.suffix in ('.html', '.js', '.css', '.json', '.xml'):
            if private_pattern.search(file.read_text()):
                errors.append(f'{file.relative_to(root)}: possible private/operational data exposed')
        if file.is_file() and any(part in ('admin', 'private', '.local-admin') for part in file.relative_to(root).parts):
            errors.append(f'{file.relative_to(root)}: private surface published')

    records = json.loads(Path('data/public/catalog.json').read_text()) or json.loads(Path('data/public/catalog.preview.json').read_text())
    editorial = json.loads(Path('data/public/editorial.json').read_text())
    preview = not json.loads(Path('data/public/catalog.json').read_text())

    def selection_exists(selection):
        if preview:
            return True
        if selection['rule'] == 'manual':
            return any(r['slug'] in selection['filmSlugs'] for r in records)
        for record in records:
            copy = next(c for c in record['copies'] if c['id'] == record['catalog_copy_id'])
            if selection['rule'] == '4k' and copy['resolution'] == '2160p':
                return True
            if selection['rule'] == 'pt-br' and any(v in ['pt-BR', 'Português (Brasil)'] for v in copy.get('subtitle_languages', [])):
                return True
        return False

    expected_routes = 2 * (len(records) + 5 + sum(selection_exists(s) for s in editorial['selections'])) + 2
    if len(pages) != expected_routes:
        errors.append(f'unexpected route count: {len(pages)} instead of {expected_routes}')
    for locale in ('', '/en'):
        listing = pages.get(locale + '/filmes/')
        if not listing or listing.card_count != len(records):
            errors.append(f'{locale}/filmes/: missing catalog cards')
        home = pages.get(locale + '/')
        valid_years = sum(isinstance(r.get('year'), int) and not isinstance(r.get('year'), bool) for r in records)
        if home:
            if editorial['showStats'] and sum(home.chart_counts) != valid_years:
                errors.append(f'{locale}/: decade counts do not equal valid works')
            if not editorial['showStats'] and home.chart:
                errors.append(f'{locale}/: statistics disabled but chart present')
        for record in records:
            detail = pages.get(f"{locale}/filmes/{record['slug']}/")
            if detail:
                for link in record.get('external_links', []):
                    if link.get('url') and link['url'] not in detail.links:
                        errors.append(f"{locale}/filmes/{record['slug']}/: source link omitted")

    sitemap_urls = []
    for file in root.glob('sitemap-*.xml'):
        tree = ET.parse(file)
        if tree.getroot().tag.endswith('urlset'):
            sitemap_urls.extend(node.text for node in tree.iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc'))
    expected_urls = {urljoin(site, prefix + route) for route, page in pages.items() if not page.noindex}
    if set(sitemap_urls) != expected_urls or len(sitemap_urls) != len(expected_urls):
        errors.append('sitemap must contain every canonical once, with the deployment base')
    return {'films': len(records), 'routes': len(pages), 'internal_links': links, 'assets': assets,
            'sitemap_urls': len(sitemap_urls), 'base': base, 'errors': errors}


if __name__ == '__main__':
    parser = ArgumentParser()
    parser.add_argument('--base', default='/')
    parser.add_argument('--site', required=True)
    parser.add_argument('--dist', type=Path, default=Path('dist'))
    args = parser.parse_args()
    result = validate(args.dist, args.base, args.site)
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result['errors']))
