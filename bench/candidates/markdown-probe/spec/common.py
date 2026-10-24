import json, glob, warnings, sys
warnings.filterwarnings('ignore')
from normalize import normalize_html
tests = json.load(open('tests.json'))
outs = {f[4:-5]: json.load(open(f)) for f in sorted(glob.glob('out-*.json'))}
def ok(h, t):
    try: return normalize_html(h) == normalize_html(t['html'])
    except Exception: return False
fails = {n: {t['example'] for t, h in zip(tests, o) if not ok(h, t)} for n, o in outs.items()}
common = set.intersection(*fails.values())
print('failed by all:', len(common), sorted(common))
for n, s in fails.items(): print(n, 'own fails', len(s - common), sorted(s - common)[:40])
if len(sys.argv) > 1:
    for ex in map(int, sys.argv[1:]):
        t = tests[[x['example'] for x in tests].index(ex)]
        print('---', ex, t['section'], repr(t['markdown']), '\nexp', repr(t['html']))
        for n, o in outs.items(): print(n, repr(o[tests.index(t)]))
