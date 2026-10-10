"""Local-only TMDB enrichment. Credentials never cross the process boundary."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import time

# The credential resolver lives outside this repository. PVCA_TMDB_RESOLVER names it;
# without it, the resolver is expected beside the checkout.
RESOLVER = Path(os.environ.get('PVCA_TMDB_RESOLVER') or
                Path(__file__).resolve().parents[2] / 'repo/tmdb/pvca_tmdb_credentials.py')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('TMDB_REDIRECT_REFUSED')

def credential():
    if not RESOLVER.is_file():
        raise RuntimeError('TMDB_RESOLVER_NOT_FOUND')
    spec = importlib.util.spec_from_file_location('pvca_tmdb_credentials', RESOLVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.resolve_token()

def select_poster(posters, original_language):
    # Original-language artwork, then language-neutral, then official en-US fallback.
    eligible = [p for p in posters if p.get('iso_639_1') in (original_language, None, 'en')
                and .55 <= p.get('aspect_ratio', 0) <= .8 and p.get('width', 0) >= 300]
    def key(p):
        language = p.get('iso_639_1')
        rank = 0 if language == original_language else 1 if language is None else 2
        return (rank, -p.get('vote_count', 0), -p.get('vote_average', 0), -p.get('width', 0), p.get('file_path', ''))
    return sorted(eligible, key=key)[0] if eligible else None

def api_requester():
    token = credential()
    opener = urllib.request.build_opener(NoRedirect())
    def request(path, params=None):
        url = 'https://api.themoviedb.org/3/' + path
        if params: url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
        for attempt in range(3):
            try:
                with opener.open(req, timeout=20) as response:
                    return json.loads(response.read(8 * 1024 * 1024))
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403): raise RuntimeError('TMDB_AUTH_FAILED') from None
                if exc.code == 404: raise RuntimeError('TMDB_NOT_FOUND') from None
                if exc.code == 429 and attempt < 2:
                    time.sleep(min(5, max(1, int(exc.headers.get('Retry-After', '1')))))
                    continue
                raise RuntimeError('TMDB_API_FAILED') from None
        raise RuntimeError('TMDB_RATE_LIMIT')
    return request, opener

def search_movies(query, year):
    request, _ = api_requester()
    matches = request("search/movie", {"query":query, "language":"en-US", "include_adult":"false"}).get("results", [])
    results = []
    for movie in matches:
        date = movie.get("release_date", "")
        if not date or abs(int(date[:4]) - year) > 1:
            continue
        credits = request(f'movie/{movie["id"]}/credits')
        results.append({"id":movie["id"], "title":movie.get("title"), "original_title":movie.get("original_title"), "year":int(date[:4]), "directors":[p["name"] for p in credits.get("crew", []) if p.get("job") == "Director"]})
    return results

def enrich(movie_id, root):
    request, opener = api_requester()
    pt = request(f'movie/{movie_id}', {'language':'pt-BR', 'append_to_response':'credits,external_ids'})
    en = request(f'movie/{movie_id}', {'language':'en-US'})
    if pt.get('id') != movie_id or en.get('id') != movie_id: raise RuntimeError('TMDB_IDENTITY_MISMATCH')
    images = request(f'movie/{movie_id}/images', {'include_image_language':','.join(dict.fromkeys([pt.get('original_language','en'),'null','en']))})
    directors = [person for person in pt.get('credits',{}).get('crew',[]) if person.get('job') == 'Director']
    date = pt.get('release_date') or None
    result = {
        'tmdb_id':movie_id, 'title':pt.get('title') or en.get('title') or '',
        'original_title':pt.get('original_title') or None, 'year':int(date[:4]) if date else None,
        'release_date':date, 'runtime_minutes':pt.get('runtime') or None,
        'directors':[p['name'] for p in directors],
        'countries':[p['name'] for p in pt.get('production_countries',[])],
        'genres':[g['name'] for g in pt.get('genres',[])],
        'original_languages':[pt['original_language']] if pt.get('original_language') else [],
        'imdb_id':pt.get('external_ids',{}).get('imdb_id') or None,
        'translations':{locale:{'title':r.get('title') or None,'synopsis':r.get('overview') or None} for locale,r in [('pt-BR',pt),('en',en)]},
        'synopsis':pt.get('overview') or None,
        'localized_metadata':{locale:{'countries':[p['name'] for p in r.get('production_countries',[])], 'genres':[g['name'] for g in r.get('genres',[])]} for locale,r in [('pt-BR',pt),('en',en)]},
        'entity_refs':{
            'directors':[{'id':f'tmdb-{p["id"]}'} for p in directors],
            'countries':[{'id':p['iso_3166_1']} for p in pt.get('production_countries',[])],
            'genres':[{'id':f'tmdb-{g["id"]}','labels':{'pt-BR':g['name'],'en':next((x['name'] for x in en.get('genres',[]) if x['id']==g['id']),g['name'])}} for g in pt.get('genres',[])],
            'original_languages':[{'id':pt['original_language']}] if pt.get('original_language') else [],
        }
    }
    poster = select_poster(images.get('posters',[]), pt.get('original_language'))
    if poster:
        image_path=poster['file_path']
        if not image_path.startswith('/') or not all(c.isalnum() or c in '/._-' for c in image_path) or '..' in image_path:
            raise RuntimeError('TMDB_IMAGE_PATH_INVALID')
        config=request('configuration')['images']
        if config.get('secure_base_url') != 'https://image.tmdb.org/t/p/': raise RuntimeError('TMDB_IMAGE_HOST_INVALID')
        size='w500' if 'w500' in config.get('poster_sizes',[]) else 'original'
        filename=f'tmdb-{movie_id}-{Path(image_path).name}'
        target=Path(root)/'public/posters'/filename
        if not target.exists():
            req=urllib.request.Request(config['secure_base_url']+size+image_path)
            with opener.open(req, timeout=20) as response:
                data=response.read(5*1024*1024+1)
            if len(data)>5*1024*1024 or not data.startswith(b'\xff\xd8'): raise RuntimeError('TMDB_IMAGE_INVALID')
            target.parent.mkdir(parents=True,exist_ok=True)
            temporary=target.with_suffix('.tmp')
            temporary.write_bytes(data);os.replace(temporary,target)
        result['poster']='/posters/'+filename
    return result

def main():
    try:
        if sys.argv[1] == 'search':
            print(json.dumps(search_movies(sys.argv[2], int(sys.argv[3])), ensure_ascii=False));return
        if sys.argv[1] == 'probe':
            token=credential()
            opener=urllib.request.build_opener(NoRedirect())
            req=urllib.request.Request('https://api.themoviedb.org/3/configuration',headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
            try:
                with opener.open(req,timeout=20) as response: config=json.loads(response.read(1024*1024))
            except urllib.error.HTTPError as exc:
                raise RuntimeError('TMDB_AUTH_FAILED' if exc.code in (401,403) else 'TMDB_API_FAILED') from None
            if config.get('images',{}).get('secure_base_url')!='https://image.tmdb.org/t/p/': raise RuntimeError('TMDB_IMAGE_HOST_INVALID')
            print(json.dumps({'available':True,'authenticated':True}));return
        if sys.argv[1] == 'status':
            credential();print(json.dumps({'available':True}));return
        movie_id=int(sys.argv[1]);root=Path(sys.argv[2]).resolve()
        if movie_id<=0: raise RuntimeError('TMDB_ID_INVALID')
        print(json.dumps(enrich(movie_id,root),ensure_ascii=False))
    except Exception as exc:
        # No raw HTTP, credential or filesystem errors leave this process.
        code=str(exc).split(':')[0]
        if not code.startswith('TMDB_'): code='TMDB_NETWORK_OR_CONFIGURATION_FAILED'
        print(json.dumps({'error':code}));sys.exit(1)

if __name__=='__main__': main()
