# Scores out-*.json against the spec's expected HTML using cmark-gfm's own normalize_html.
import json, glob, collections, warnings
warnings.filterwarnings('ignore')
from normalize import normalize_html
tests = json.load(open('tests.json'))
for f in sorted(glob.glob('out-*.json')):
    out = json.load(open(f)); ok = 0; fails = collections.Counter(); ext = collections.Counter(); extok = collections.Counter()
    for t, h in zip(tests, out):
        e = tuple(t['extensions']); ext[e] += 1
        try: good = normalize_html(h) == normalize_html(t['html'])
        except Exception: good = False
        if good: ok += 1; extok[e] += 1
        else: fails[t['section']] += 1
    gx = {('table',):'table',('strikethrough',):'strike',('autolink',):'autolink',('tagfilter',):'tagfilter'}
    print(f"{f[4:-5]:14} {ok}/{len(tests)} ({100*ok/len(tests):.1f}%)  ext:", ' '.join(f"{gx[k]} {extok[k]}/{v}" for k,v in ext.items() if k), ' top fails:', fails.most_common(4))
