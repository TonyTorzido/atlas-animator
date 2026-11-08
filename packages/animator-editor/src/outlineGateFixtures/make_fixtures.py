"""Builds the outlineGate fixtures: three synthetic frames (full figure | garment piece alone, side by side in one RGBA PNG) and
expected.json, produced by running the reference `edge_breaks` from swag_outline_gate.py (the function is lifted out of that file
with ast, so nothing else of the kit is needed).

    python src/outlineGateFixtures/make_fixtures.py        (from packages/animator-editor; needs numpy, scipy, Pillow)
"""
import ast, json, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage

here = pathlib.Path(__file__).parent
src = (here / "swag_outline_gate.py").read_text(encoding="utf-8")
tree = ast.parse(src)
want = {"edge_breaks"}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in want)
        or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("MAX_BREAK", "INK_MAX") for t in n.targets))]
ns = {"np": np, "ndimage": ndimage}
exec(compile(ast.Module(body=body, type_ignores=[]), "swag_outline_gate.py", "exec"), ns)
edge_breaks = ns["edge_breaks"]

W = H = 64
INK, CLOTH, SKIN, OVER = (22, 14, 10), (150, 110, 70), (200, 160, 140), (60, 90, 170)


def rrect(x0, y0, x1, y1):
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def piece_image(mask, gaps=(), fringe=False):
    """RGBA: cloth inside, a 4 px ink band along the silhouette edge, then `gaps` (x0, y0, x1, y1) painted cloth over the band."""
    g = np.zeros((H, W, 4), np.float32)
    inner = ndimage.binary_erosion(mask, iterations=4)
    g[mask, :3] = INK
    g[inner, :3] = CLOTH
    g[mask, 3] = 255
    for x0, y0, x1, y1 in gaps:
        sel = np.zeros((H, W), bool)
        sel[y0:y1, x0:x1] = True
        g[sel & mask, :3] = CLOTH
    if fringe:  # antialiased one-pixel edge
        edge = mask & ~ndimage.binary_erosion(mask)
        g[edge, 3] = 140
        g[edge, :3] = (60, 50, 40)
    return g


def figure(piece, mask, occluder=None):
    f = np.zeros((H, W, 4), np.float32)
    body = rrect(2, 2, 62, 62)
    f[body] = (*SKIN, 255)
    f[mask] = piece[mask]
    if occluder is not None:
        f[occluder] = (*OVER, 255)
    return f


cases = {}
# 1) a clean piece: one unbroken ink line
m = rrect(10, 14, 54, 50)
p = piece_image(m)
cases["clean"] = (figure(p, m), p)
# 2) three gaps of different lengths on a piece, one of them only 2 px long (not counted), one diagonal staircase
m = rrect(8, 10, 56, 54)
gaps = [(16, 10, 26, 15), (40, 10, 42, 15), (8, 30, 13, 42)]
p = piece_image(m, gaps)
stair = piece_image(m, gaps)
for i in range(9):
    stair[50 - i:51 - i, 20 + i:21 + i, :3] = CLOTH
cases["gaps"] = (figure(stair, m), stair)
# 3) a gap hidden under another piece (not on top, so it does not count) plus a visible gap, with an antialiased fringe
m = rrect(6, 8, 58, 56)
p = piece_image(m, [(20, 8, 34, 14), (44, 50, 52, 57)], fringe=True)
occ = rrect(16, 4, 38, 16)
cases["occluded"] = (figure(p, m, occ), p)

expected = {}
for name, (full, alone) in cases.items():
    n, longest, bad = edge_breaks(full, alone)
    expected[name] = {"breaks": int(n), "longest": float(longest), "badPixels": int(bad.sum())}
    both = np.concatenate([full, alone], axis=1).astype(np.uint8)
    Image.fromarray(both).save(here / f"{name}.png", optimize=True)
(here / "expected.json").write_text(json.dumps({"width": W, "height": H, "maxBreak": 2.0, "inkMax": 40, "cases": expected}, indent=1) + "\n")
print(json.dumps(expected, indent=1))
