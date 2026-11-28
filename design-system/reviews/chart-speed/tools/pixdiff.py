# Where two screenshots of one state differ: count of differing pixels and their bounding box. python3 -I pixdiff.py <dir with <state>.<build>.png pairs>
import sys, os, glob
from PIL import Image
import numpy as np
d = sys.argv[1]
names = sorted(set(f.rsplit('.', 2)[0] for f in os.listdir(d) if f.endswith('.png')))
for n in names:
    fs = sorted(glob.glob(os.path.join(d, n + '.*.png')))
    if len(fs) < 2: continue
    a, b = (np.asarray(Image.open(f).convert('RGBA')).astype(int) for f in fs[:2])
    if a.shape != b.shape: print(n, 'sizes differ', a.shape, b.shape); continue
    m = (a != b).any(axis=2); ys, xs = np.nonzero(m)
    print(f"{n}: {m.sum()} px" + (f" in x {xs.min()}..{xs.max()}, y {ys.min()}..{ys.max()}; max channel diff {np.abs(a-b).max()}" if m.sum() else ''))
