#: deterministic cuff extension of existing
# garment art (or a template allowed mask) after scripts/cuff-to-wrist.ts moved the domain's forearm cuff cuts onto
# the wrist dip (source.cuffToWrist.moved: the art's old cut `from`, the new cut `to`).
# Per arm, in the frame of the new cut (v across it, u down the forearm, u = 0 on the new cut), per sleeve column:
#   e(v)  = the drawn end near the old cut (alpha >= 128), e' = the median overhang past the old cut, now past the
#           new cut, but at least MIN_OVER px past it (the hem's rounded corners then sit past the cut, so the sleeve
#           side is full width where the mesh cuts it), the same for every column, so the hem ends square on the new
#           cut (shift s = e' - e, either sign);
#   cuff band [e - ZONE, e]  -> translated by s (trim, stitching, lacing, banding and the hem outline keep their look);
#   fabric [e - ZONE - FAB, e - ZONE] (up to the first gap in the column) -> resampled linearly onto [e - ZONE - FAB, e' - ZONE] (stretched or squeezed
#           along the forearm: the weave / mail continues with no copy seam, identity at the top of the stretch);
#   past the moved end -> transparent (a shift up clears the old hem rows).
# The columns of the sleeve's side outline, its antialias included (alpha >= 8), are measured too, so the side outline runs down to the new corner and no stray outline pixels are left
# at the old one. Only the sleeve moves: inside the edited region, the art is split into pieces (alpha > 0, connected
# within the region) and only the pieces holding a measured sleeve end are sampled or overwritten (the torso beside
# the inner side of the sleeve is left as it is). Sampling is bilinear on premultiplied RGBA (masks: thresholded at 50%).
#   python extend-cuffs.py <domain.json> <in.png> <out.png> [--mask]
# --mask: an L/RGB allowed mask (white = allowed) instead of RGBA art.
import json
import sys
import numpy as np
from scipy import ndimage
from PIL import Image

ZONE = 26         # px of the sleeve end translated (hem band, trim and the hem outline sit inside this)
FAB = 80          # px of fabric above the band resampled along the forearm
MIN_OVER = 3.0    # px: the hem ends at least this far past the new cut
PAD = 11          # px past each cut end (the sleeve side outline runs margin + half a stroke outside the body edge)
CORNER = 4        # px past PAD scanned for soft side-outline columns; 1 px past the outermost one edited
SCAN = (-14, 40)  # u window (px from the old cut) searched for the drawn end


def arm_frames(domain):
    for m in domain["source"]["cuffToWrist"]["moved"]:
        f0, f1 = (np.array(p, float) for p in m["from"])
        t0, t1 = (np.array(p, float) for p in m["to"])
        t = (t1 - t0) / np.linalg.norm(t1 - t0)
        n = np.array([-t[1], t[0]])
        if n[1] < 0:  # down the forearm (the arm hangs below the shoulders at rest)
            n = -n
        yield m["cut"], t0, t, n, np.linalg.norm(t1 - t0), f0, f1


def bilinear(pm, x, y):
    """pm: HxWx4 float premultiplied; x, y float arrays. Out of range = transparent."""
    H, W = pm.shape[:2]
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]

    def at(xx, yy):
        ok = (xx >= 0) & (xx < W) & (yy >= 0) & (yy < H)
        r = np.zeros(xx.shape + (4,))
        r[ok] = pm[yy[ok], xx[ok]]
        return r

    return (at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
            + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy)


def extend(img, domain):
    """img: HxWx4 uint8 (alpha = coverage). Returns the edited copy and a report."""
    H, W = img.shape[:2]
    src = img
    a8 = src[..., 3].astype(float) / 255.0
    pm = src.astype(float)
    pm[..., :3] *= a8[..., None]
    out = pm.copy()
    edited = np.zeros((H, W), bool)
    rep = []
    ys, xs = np.mgrid[0:H, 0:W]
    for cut, a, t, n, L, f0, f1 in arm_frames(domain):
        P = np.stack([xs + 0.5 - a[0], ys + 0.5 - a[1]], -1)
        v = P @ t
        u = P @ n
        fv = np.array([(f0 - a) @ t, (f1 - a) @ t])
        fu = np.array([(f0 - a) @ n, (f1 - a) @ n])
        uold = lambda vv: fu[0] + (fu[1] - fu[0]) * (vv - fv[0]) / (fv[1] - fv[0])
        uend = {}
        for vv in np.arange(int(np.floor(-PAD - CORNER)), int(np.ceil(L + PAD + CORNER)) + 1):
            uo = uold(vv)
            last = solid = None
            for uu in np.arange(uo + SCAN[0], uo + SCAN[1], 0.5):
                p = a + t * vv + n * uu
                x, y = int(np.floor(p[0])), int(np.floor(p[1]))
                al = src[y, x, 3] if 0 <= x < W and 0 <= y < H else 0
                if al >= 8:  # the run (antialias included: the side outline's soft columns move with the sleeve)
                    last = uu
                    if al >= 128:
                        solid = uu
                elif last is not None:
                    break
            if last is not None and last < uo + SCAN[1] - 2:  # art running on past the window is the torso, not a sleeve end
                uend[vv] = (solid if solid is not None else last, uo)
        if not uend:
            rep.append((cut, "no sleeve end found"))
            continue
        over = float(np.median([e - uo for e, uo in uend.values()]))
        sv = np.array(sorted(uend), float)
        se = np.array([uend[k][0] for k in sv.astype(int)])
        # the drawn end per column, lightly smoothed (antialias noise), kept at the measured value on the outline
        se = np.array([np.median(se[max(0, i - 2):i + 3]) for i in range(len(se))])
        e_at = np.interp(v, sv, se)                 # clamps: corner columns take the outermost mapping
        e2 = max(over, MIN_OVER)
        s_at = e2 - e_at
        top = e_at - ZONE                           # band top in the source
        # identity above the anchor: FAB px above the band, or the first gap going up the column (the wedge between
        # the sleeve's inner side and the torso is never stretched, so their outlines stay single and clean)
        sa = []
        for k, vv in enumerate(sv):
            uu = se[k] - ZONE
            while uu > se[k] - ZONE - FAB:
                p = a + t * vv + n * (uu - 0.5)
                x, y = int(np.floor(p[0])), int(np.floor(p[1]))
                if not (0 <= x < W and 0 <= y < H) or src[y, x, 3] < 8:
                    break
                uu -= 0.5
            sa.append(uu)
        anchor = np.interp(v, sv, np.array(sa))
        inside = (v >= sv[0] - 1) & (v <= sv[-1] + 1) & (u >= anchor) & (u <= np.maximum(e_at, e2) + 2.5)
        # source u for every output texel of the region
        su = np.where(u >= e2 - ZONE, u - s_at, anchor + (u - anchor) * (top - anchor) / np.maximum(e2 - ZONE - anchor, 1.0))
        su = np.where(su > e_at + 2.5, np.nan, su)  # nothing past the old end comes along
        su = np.where(u > e2 + 1.5, np.nan, su)     # nor past the new end line (no corner spikes from the side outline)
        # the sleeve piece(s) of the region: connected art holding the measured ends
        reach = (v >= sv[0] - CORNER - 2) & (v <= sv[-1] + CORNER + 2) & (u >= anchor - 2) & (u <= np.maximum(e_at, e2) + SCAN[1])
        lab, _ = ndimage.label(reach & (src[..., 3] > 0))
        seeds = set()
        for vv, (e, _uo) in uend.items():
            p = a + t * vv + n * (e - 1)
            seeds.add(int(lab[int(np.floor(p[1])), int(np.floor(p[0]))]))
        seeds.discard(0)
        sleeve = np.isin(lab, list(seeds))
        other = (src[..., 3] > 0) & ~sleeve
        inside &= ~other
        pm_s = pm * sleeve[..., None]
        yy, xx = np.nonzero(inside)
        vv_ = v[yy, xx]
        suu = su[yy, xx]
        gone = np.isnan(suu)
        sx = a[0] + t[0] * vv_ + n[0] * np.nan_to_num(suu) - 0.5
        sy = a[1] + t[1] * vv_ + n[1] * np.nan_to_num(suu) - 0.5
        val = bilinear(pm_s, sx, sy)
        val[gone] = 0
        out[yy, xx] = val
        edited[yy, xx] = True
        rep.append((cut, "overhang %.1f -> %.1f px, shift %.1f..%.1f px, %d texels" % (over, e2, (e2 - se).min(), (e2 - se).max(), len(yy))))
    al = out[..., 3:4]
    rgb = np.where(al > 0, out[..., :3] / np.maximum(al, 1e-6) * 255.0, 0)
    res = np.clip(np.round(np.concatenate([rgb, al], -1)), 0, 255).astype(np.uint8)
    res[~edited] = src[~edited]
    return res, rep


if __name__ == "__main__":
    dom_path, inp, outp = sys.argv[1:4]
    mask = "--mask" in sys.argv
    domain = json.load(open(dom_path, encoding="utf-8"))
    im = Image.open(inp)
    if mask:
        m = np.array(im.convert("L"))
        rgba = np.zeros(m.shape + (4,), np.uint8)
        rgba[..., :3] = 255
        rgba[..., 3] = np.where(m > 127, 255, 0)
        res, rep = extend(rgba, domain)
        Image.fromarray(np.where(res[..., 3] >= 128, 255, 0).astype(np.uint8)).convert(im.mode).save(outp)
    else:
        res, rep = extend(np.array(im.convert("RGBA")), domain)
        Image.fromarray(res).save(outp)
    for r in rep:
        print(outp, *r)
