#!/usr/bin/env python3
"""Shrink design-review images so the review directory stays small enough to commit.

    python3 e2e/encode-review-images.py ../design-system/reviews/app-restyle

before/ and after/ are halved (they are captured at device scale factor 2); compare/ keeps
its size. All are stored with a 256-colour palette made of every colour in tokens.json plus
the image's own most frequent colours, so a token colour is never shifted: a generic
median-cut palette turned the yellow warning mark pink, and an octree palette merged the
sunken grey into white. Run it once, after `shots.mjs compare`, on freshly captured images.
Compare images that have no "before" are removed, because the same picture is in after/.
"""
import glob, json, os, re, sys
import numpy as np
from PIL import Image

root = sys.argv[1]
tokens = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../design-system/project/tokens.json')))
forced = []
for t in tokens['color']['tokens']:
    for v in ([t['value']] if isinstance(t['value'], str) else t['value'].values()):
        rgb = tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))
        if rgb not in forced:
            forced.append(rgb)

for f in glob.glob(os.path.join(root, 'compare', '*.png')):
    if not os.path.exists(os.path.join(root, 'before', os.path.basename(f))):
        os.remove(f)

def encode(path, scale):
    im = Image.open(path).convert('RGB')
    if scale != 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    px = np.asarray(im).reshape(-1, 3)
    uniq, inverse, counts = np.unique(px, axis=0, return_inverse=True, return_counts=True)
    colours = list(forced)
    seen = set(forced)
    for i in np.argsort(-counts):
        if len(colours) >= 256:
            break
        c = tuple(int(x) for x in uniq[i])
        if c not in seen:
            seen.add(c)
            colours.append(c)
    palette = np.array(colours, dtype=np.int32)
    # Each distinct colour goes to its exact palette entry, or to the nearest one.
    nearest = np.empty(len(uniq), dtype=np.uint8)
    for start in range(0, len(uniq), 4096):
        chunk = uniq[start:start + 4096].astype(np.int32)
        nearest[start:start + 4096] = ((chunk[:, None, :] - palette[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
    out = Image.fromarray(nearest[inverse.reshape(-1)].reshape(im.height, im.width), 'P')
    out.putpalette([x for c in colours for x in c] + [0] * (768 - 3 * len(colours)))
    out.save(path, optimize=True)

for d, scale in (('compare', 1), ('before', 0.5), ('after', 0.5)):
    for f in glob.glob(os.path.join(root, d, '*.png')):
        encode(f, scale)
