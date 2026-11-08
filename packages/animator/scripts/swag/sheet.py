# One concept sheet per piece: the approved jacket + each option ON THE REAL RIG, at rest. Every tile is the Atlas
# Animator's own render (renderFrames at scale 0.4, via render-rest.ts): top row the 0.4 figure, bottom row the
# torso of that same 0.4 render at x3 (nearest). No downscaled art tiles. Plus the live bandit mob as the bar.
#   python sheet.py <piece> <label> <name>=<rig.anim.json> ...      (an option needs an import before it gets a tile)
# Repo copy: packages/animator/scripts/swag/sheet.py; renders with render-rest.ts next to it on this
# checkout's animator; sheets go to $SWAG_ROOT/sheets (default ART_DROPS/swag-chinese-concepts-01/sheets).
import os, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

DROPS = Path(os.environ.get("ART_DROPS", "art-drops"))
ROOT = Path(os.environ.get("SWAG_ROOT", str(DROPS / "swag-chinese-concepts-01")))
WT = Path(os.environ.get("ANIMATOR", str(Path(__file__).resolve().parents[2])))
JACKET = WT / "fixtures/test-rigs/jacket/template7-shoulder-legs-jacket.anim.json"
BANDIT = DROPS / "smooth-full-02/final/bandit.png"
S = 0.4
FIG = (30, 30, 405, 550)    # figure box in the 0.4 render
TORSO = (110, 230, 330, 400)  # torso box in the 0.4 render (x3 below)
try:
    FONT = ImageFont.truetype("arialbd.ttf", 22)
    FONT_S = ImageFont.truetype("arial.ttf", 17)
except OSError:
    FONT = FONT_S = ImageFont.load_default()


def render(items):
    out = Path(tempfile.mkdtemp(prefix="sheet-"))
    subprocess.run(["npx", "tsx", str(Path(__file__).resolve().parent / "render-rest.ts"), str(out), str(S), "rest", "0"] +
                   [f"t{i}={Path(p).resolve()}" for i, (_, p) in enumerate(items)], cwd=WT, check=True, shell=os.name == "nt")
    return [Image.open(out / f"t{i}.png").convert("RGB") for i in range(len(items))]


def main():
    piece, label = sys.argv[1], sys.argv[2]
    items = [("APPROVED kung-fu jacket (bar)", JACKET)]
    for a in sys.argv[3:]:
        k, v = a.split("=", 1)
        if not v.endswith(".anim.json"):
            sys.exit(f"{k}: give the imported rig (.anim.json), not art; sheets show real renders only")
        items.append((k, Path(v)))
    renders = render(items)
    small = [r.crop(FIG) for r in renders]
    big = [r.crop(TORSO).resize(((TORSO[2] - TORSO[0]) * 3, (TORSO[3] - TORSO[1]) * 3), Image.NEAREST) for r in renders]
    b = Image.open(BANDIT).convert("RGBA")
    bb = np.array(b)[..., 3] > 0
    ys, xs = np.where(bb)
    b = b.crop((xs.min() - 10, ys.min() - 10, xs.max() + 10, ys.max() + 10))
    sc = round((FIG[3] - FIG[1]) * 0.8) / b.size[1]
    b = b.resize((round(b.size[0] * sc), round(b.size[1] * sc)), Image.LANCZOS)
    bandit = Image.new("RGB", b.size, (180, 185, 194))
    bandit.paste(b, (0, 0), b)
    pad, head = 24, 40
    W = max(sum(i.size[0] for i in small) + bandit.size[0] + pad * (len(small) + 2), sum(i.size[0] for i in big) + pad * (len(big) + 1))
    h_small, h_big = small[0].size[1], big[0].size[1]
    H = 70 + head + h_small + 30 + head + h_big + pad
    sheet = Image.new("RGB", (W, H), (236, 234, 228))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 18), label + "   (real rig renders: top 0.4 game zoom, bottom the same 0.4 render x3)", fill=(20, 20, 20), font=FONT)
    x, y = pad, 70
    for (n, _), i in zip(items, small):
        d.text((x, y), n, fill=(20, 20, 20), font=FONT_S)
        sheet.paste(i, (x, y + head))
        x += i.size[0] + pad
    d.text((x, y), "live bandit mob (detail bar)", fill=(20, 20, 20), font=FONT_S)
    sheet.paste(bandit, (x, y + head + h_small - bandit.size[1]))
    x, y = pad, 70 + head + h_small + 30
    for (n, _), i in zip(items, big):
        d.text((x, y), n, fill=(20, 20, 20), font=FONT_S)
        sheet.paste(i, (x, y + head))
        x += i.size[0] + pad
    out = ROOT / "sheets"
    out.mkdir(exist_ok=True)
    sheet.save(out / f"{piece}.png")
    print(out / f"{piece}.png", sheet.size)


main()
