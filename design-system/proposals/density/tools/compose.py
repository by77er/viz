"""Compose side-by-side images: the same view, layout, theme and state in each build, labelled.
   python3 -I compose.py <out.png> <kind: screen|page> <view> <layout> <theme> <label>=<png> ...
   Pages are cut to a common height (the tallest, padded with a neutral grey) and scaled so the composition stays small."""
import sys
from PIL import Image, ImageDraw, ImageFont

out, kind, view, layout, theme = sys.argv[1:6]
pairs = [a.split('=', 1) for a in sys.argv[6:]]
ims = [(label, Image.open(path).convert('RGB')) for label, path in pairs]
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
w = ims[0][1].size[0]
scale = 1.0
if kind == 'page':
    scale = 0.5 if w > 1000 else 0.75
H = max(im.size[1] for _, im in ims)
head = 40
gap = 24
W = len(ims) * int(w * scale) + (len(ims) - 1) * gap
canvas = Image.new('RGB', (W, head + int(H * scale)), (128, 128, 128))
d = ImageDraw.Draw(canvas)
x = 0
for label, im in ims:
    if scale != 1.0:
        im = im.resize((int(im.size[0] * scale), int(im.size[1] * scale)), Image.LANCZOS)
    d.rectangle([x, 0, x + im.size[0], head], fill=(255, 255, 255))
    d.text((x + 8, 8), f'{label}  ({view}, {layout}, {theme}, {im.size[1] if scale == 1 else int(im.size[1] / scale)} px tall)', fill=(0, 0, 0), font=font)
    canvas.paste(im, (x, head))
    x += im.size[0] + gap
canvas.quantize(colors=128, method=Image.Quantize.MEDIANCUT).save(out, optimize=True)
