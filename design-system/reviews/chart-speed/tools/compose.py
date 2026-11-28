# compose.py: before | after, side by side, for every case of frame-shots.cjs's records, each image with its frame's record printed
# above it (the frame time after the press, what the record read in that frame, and the image's file).
#   python3 -I compose.py <out dir> <shots-*.json> ...
# Per case (view, series, layout, theme) one image: the first frame that shows the new result in each build, and, where the waiting
# line was still over it there, the first frame without the line.
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
src_dir = None
try:
    font = ImageFont.load_default(size=22)
except TypeError:
    font = ImageFont.load_default()
CAP = 92

def caption(img, lines, scale):
    w = img.width
    c = Image.new('RGB', (w, CAP), (255, 255, 255))
    d = ImageDraw.Draw(c)
    for k, t in enumerate(lines):
        d.text((12, 8 + k * 27), t, fill=(0, 0, 0), font=font)
    o = Image.new('RGB', (w, CAP + img.height), (255, 255, 255))
    o.paste(c, (0, 0)); o.paste(img.convert('RGB'), (0, CAP))
    return o

for f in sys.argv[2:]:
    d = json.load(open(f))
    img_dir = os.path.join(os.path.dirname(f), 'images')
    by = {}
    for r in d['runs']:
        by.setdefault((r['view'], r['series']), {})[r['build']] = r
    for (view, series), builds in by.items():
        cols = []
        for b in ['before', 'after']:
            r = builds.get(b)
            if not r:
                continue
            for im in r['images']:
                if im['what'] not in ('new-result', 'new-result-line-gone', 'line-gone'):
                    continue
                line = 'waiting line: "' + im['line'] + '"' if im['line'] is not None else 'waiting line: none'
                lines = [f"{b}: frame at {im['t']:.1f} ms after the press ({'first frame with the new result' if im['what'] != 'line-gone' else 'first frame without the line'})",
                         f"{line}; plot written {im['plot']}x; stale label {'shown' if im['stale'] else 'not shown'}",
                         f"BeginFrame time {im['frameTime']:.3f} (clock offset {r['clockOffsetMs']:.3f}); {im['file']}"]
                cols.append(caption(Image.open(os.path.join(img_dir, im['file'])), lines, 1))
        if not cols:
            continue
        H = max(c.height for c in cols); W = sum(c.width for c in cols) + 16 * (len(cols) - 1)
        sheet = Image.new('RGB', (W, H), (128, 128, 128)); x = 0
        for c in cols:
            sheet.paste(c, (x, 0)); x += c.width + 16
        name = f"{'dashboard' if view.startswith('dashboard') else 'explore-' + str(series)}-{d['layout']}-{d['theme']}.png"
        sheet.save(os.path.join(out, name), optimize=True)
        print(name, sheet.size)
