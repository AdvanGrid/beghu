"""Side-by-side p50 / p95 per cell and scenario for two or more results directories."""
import json, sys
runs = [(d.rstrip('/').split('/')[-1], json.load(open(f'{d}/results.json'))) for d in sys.argv[1:]]
SC = ['cold', 'warm', 'filter', 'early', 'scroll', 'detail', 'live', 'write']
def cell_map(r): return {c['id']: {x['scenario']: x for x in c['results']} for c in r['cells']}
maps = [(n, cell_map(r)) for n, r in runs]
cells = [c['id'] for c in runs[0][1]['cells']]
def fmt(x):
    if x is None: return '—'
    err = len(x.get('errors', []))
    if x['scenario'] == 'scroll':
        f = x.get('frame_ms') or {}
        lt = x.get('long_tasks', {})
        s = f"{f.get('p95','—')} fr"
        over = lt.get('over_100ms') if isinstance(lt, dict) else None
        if over is not None: s += f", {over} >100"
    else:
        l = x.get('latency_ms') or {}
        s = f"{l.get('p50','—')} / {l.get('p95','—')}" if l else '—'
    return s + (f" ({err} err)" if err else '')
for cid in cells:
    print(f'\n### {cid}\n')
    print('| scenario | ' + ' | '.join(n for n, _ in maps) + ' |')
    print('|---|' + '---|' * len(maps))
    for sc in SC:
        print(f'| {sc} | ' + ' | '.join(fmt(m.get(cid, {}).get(sc)) for _, m in maps) + ' |')
