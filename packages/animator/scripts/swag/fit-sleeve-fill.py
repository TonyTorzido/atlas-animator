#: edge-fit pass after extend-cuffs. Where a forearm's art stops short of
# the runtime silhouette (scripts/garment-edge.ts: per boundary anchor, the rest point, the outward direction and
# the distance the importer's silhouette check measures against), the sleeve FILL is continued out to it:
#   per forearm anchor with a deficit (art exit < target - TOL), the strip between the anchor and target - INSET px
#   out along its direction becomes sleeve fabric, together with the art's own outline ink within INK_BAND px inside
#   the art edge there (the stranded hem hook and the inner outline the runtime outline replaces). Only transparent
#   or ink texels are painted; other art (the torso and its outline) is never overwritten.
#   Fabric is the sleeve's own neighbouring texture: each painted texel copies the sleeve texel FAB_STEP px past the
#   first fabric texel (opaque, INK_CLEAR px clear of ink) found going inward against the anchor direction (so the
#   weave continues outward); failing that, the nearest fabric texel. Inside the hem band (HEM px above a moved cuff
#   cut, domain source.cuffToWrist.moved) the band's own rows (its hem line, trim and stitching) are continued sideways
#   instead: only transparent texels are painted, each copying the first opaque texel inward, ink included. No new ink
#   is drawn anywhere else.
#   python fit-sleeve-fill.py <edge.json> <domain.json> <in.png> <out.png> [--groups forearm,forearm_r] [--dry]
import json
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

TOL = 1.0       # px: deficits up to this are left alone
INSET = 1.0     # px inside the target the fill stops (the runtime outline covers it; never past the target)
INK_BAND = 14   # px inside the art edge where the art's outline ink is repainted as fabric
INK_DIST = 40   # RGB distance to the outline ink colour that counts as ink
MAX_IN = 60     # px searched inward for fabric
INK_CLEAR = 2   # px fabric samples keep clear of ink (its antialiased rim)
FAB_STEP = 2.0  # px past the first fabric texel the sample is taken
HEM = 26        # px above a moved cuff cut that belong to the hem band (extend-cuffs ZONE)


def art_exit(alpha, p, n, start=0.0):
    H, W = alpha.shape
    for t in np.arange(start, 60, 0.5):
        x, y = int(round(p[0] + n[0] * t)), int(round(p[1] + n[1] * t))
        if x < 0 or y < 0 or x >= W or y >= H or alpha[y, x] < 128:
            return t
    return -1


def ink_colour(img):
    """The outline ink: the most common colour among the darkest 3 % of opaque texels (quantised)."""
    op = img[..., 3] >= 250
    rgb = img[..., :3][op].astype(int)
    lum = rgb @ np.array([299, 587, 114]) // 1000
    dark = rgb[lum <= np.percentile(lum, 3)]
    q = (dark // 4) * 4
    vals, counts = np.unique(q, axis=0, return_counts=True)
    return vals[counts.argmax()] + 2


def hem_band(domain, H, W):
    ys, xs = np.mgrid[0:H, 0:W]
    band = np.zeros((H, W), bool)
    for m in domain.get("source", {}).get("cuffToWrist", {}).get("moved", []):
        t0, t1 = (np.array(q, float) for q in m["to"])
        L = np.linalg.norm(t1 - t0)
        t = (t1 - t0) / L
        n = np.array([-t[1], t[0]])
        if n[1] < 0:
            n = -n
        v = (xs + 0.5 - t0[0]) * t[0] + (ys + 0.5 - t0[1]) * t[1]
        u = (xs + 0.5 - t0[0]) * n[0] + (ys + 0.5 - t0[1]) * n[1]
        band |= (v > -30) & (v < L + 30) & (u > -HEM) & (u < 30)
    return band


def fit(img, edge, domain, groups, dry=False):
    H, W = img.shape[:2]
    alpha = img[..., 3]
    ink = ink_colour(img)
    is_ink = (np.abs(img[..., :3].astype(int) - ink).sum(-1) < INK_DIST) & (alpha >= 128)
    paint = np.zeros((H, W), bool)
    normal = np.zeros((H, W, 2))
    rep = []
    for ri, run in enumerate(edge["runs"]):
        an = [a for a in run["anchors"] if a["group"] in groups]
        res = []
        for a in an:
            e = art_exit(alpha, a["p"], a["n"])
            res.append(None if e < 0 else e - a["target"])
        bad = [k for k, r in enumerate(res) if r is not None and r < -TOL]
        if not bad:
            continue
        rep.append((ri, len(bad), min(res[k] for k in bad)))
        if dry:
            for k in bad:
                rep.append(("  anchor", an[k]["i"], an[k]["group"], [round(c) for c in an[k]["p"]], round(res[k], 2)))
            continue
        # strips between consecutive anchors where either has a deficit (one quad per pair), plus the ink band
        ks = sorted(set(bad) | {k + 1 for k in bad if k + 1 < len(an)} | {k - 1 for k in bad if k > 0})
        for k0, k1 in zip(ks, ks[1:]):
            if k1 != k0 + 1:
                continue
            a0, a1 = an[k0], an[k1]
            p0, p1 = np.array(a0["p"]), np.array(a1["p"])
            n0, n1 = np.array(a0["n"]), np.array(a1["n"])
            poly = [p0 - n0 * INK_BAND, p1 - n1 * INK_BAND, p1 + n1 * (a1["target"] - INSET), p0 + n0 * (a0["target"] - INSET)]
            m = Image.new("L", (W, H), 0)
            ImageDraw.Draw(m).polygon([tuple(q) for q in poly], fill=255)
            m = np.array(m) > 0
            nn = (n0 + n1) / np.linalg.norm(n0 + n1)
            normal[m] = nn
            paint |= m
    near_ink = ndimage.binary_dilation(is_ink, iterations=INK_CLEAR)
    hem = hem_band(domain, H, W)
    target = paint & ((alpha < 255) | (near_ink & ~hem))
    fabric = (alpha >= 250) & ~near_ink & ~target
    _, (iy, ix) = ndimage.distance_transform_edt(~fabric, return_indices=True)
    out = img.copy()
    yy, xx = np.nonzero(target)
    miss = 0
    for y, x in zip(yy, xx):
        nx, ny = normal[y, x]
        src = None
        if hem[y, x]:
            for t in np.arange(1, MAX_IN, 0.5):
                sx, sy = int(round(x - nx * t)), int(round(y - ny * t))
                if not (0 <= sx < W and 0 <= sy < H):
                    break
                if alpha[sy, sx] >= 250 and not target[sy, sx]:
                    fx, fy = int(round(x - nx * (t + 1))), int(round(y - ny * (t + 1)))
                    src = (fy, fx) if 0 <= fx < W and 0 <= fy < H and alpha[fy, fx] >= 250 else (sy, sx)
                    break
        for t in np.arange(1, MAX_IN, 0.5) if src is None else ():
            sx, sy = int(round(x - nx * t)), int(round(y - ny * t))
            if not (0 <= sx < W and 0 <= sy < H):
                break
            if fabric[sy, sx]:
                fx, fy = int(round(x - nx * (t + FAB_STEP))), int(round(y - ny * (t + FAB_STEP)))
                src = (fy, fx) if 0 <= fx < W and 0 <= fy < H and fabric[fy, fx] else (sy, sx)
                break
        if src is None:
            src = (iy[y, x], ix[y, x])
            miss += 1
        out[y, x, :3] = img[src][:3]
        out[y, x, 3] = 255
    rep.append(("painted", len(yy), "nearest-fabric fallback", miss))
    return out, rep


if __name__ == "__main__":
    edge_path, dom_path, inp, outp = sys.argv[1:5]
    groups = {"forearm", "forearm_r"}
    if "--groups" in sys.argv:
        groups = set(sys.argv[sys.argv.index("--groups") + 1].split(","))
    dry = "--dry" in sys.argv
    edge = json.load(open(edge_path, encoding="utf-8"))
    img = np.array(Image.open(inp).convert("RGBA"))
    domain = json.load(open(dom_path, encoding="utf-8"))
    res, rep = fit(img, edge, domain, groups, dry)
    if not dry:
        Image.fromarray(res).save(outp)
    for r in rep:
        print(outp, *r)
