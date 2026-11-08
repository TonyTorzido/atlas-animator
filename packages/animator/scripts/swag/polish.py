# Deterministic polish of untouched generated art -> registered garment PNGs on the rig canvas.
#   python polish.py <concept-id> [<concept-id> ...]
# For each output/gen-*.png: downscale the 1536x1024 crop back to canvas px (x3/8), find the small
# translation/scale that best registers the painted garment on the template's allowed mask, place it on
# the 1086x1448 canvas, alpha = allowed mask (0/255), and repaint a solid 9 px outline band on the mask
# edge in the generation's own outline colour. No colour snapping, no flattening.
# Repo copy: packages/animator/scripts/swag/polish.py, a standalone script (the swag:make pipeline may call
# it). Concept folders live in $SWAG_ROOT (default ART_DROPS/swag-chinese-concepts-01): <id>/output/gen-*.png ->
# <id>/final/gen-*-garment.png; each id's template (simple|medium) comes from $SWAG_ROOT/tools/concepts.json.
import os
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

DROPS = Path(os.environ.get("ART_DROPS", "art-drops"))
ROOT = Path(os.environ.get("SWAG_ROOT", str(DROPS / "swag-chinese-concepts-01")))
CROP = (252, 614, 828, 998)
CW, CH = CROP[2] - CROP[0], CROP[3] - CROP[1]
MASKS = {"simple": DROPS / "swag-chinese-01/wrap-02/ref/allowed-mask.png",
         "medium": DROPS / "swag-chinese-01/jade-02/ref/allowed-mask.png"}
OUTLINE_W = 9
CLAMP = True
FIT = True     # waist fit: per-row horizontal remap of each mask segment's edges onto the template mask edges
FIT_BAND = 60  # px over which an edge offset is eased back to 0 toward the segment's middle
FIT_MAX = 30   # px largest edge move (bigger = a mismatch, left alone)
CUT_SMOOTH = 6  # rows: half-window for smoothing closed-gap cut positions and drawn gap ends along their track ()
EDGE_MEAN = 4   # rows: half-window of the mean pass after the edge-offset median (no stepped, blocky edges)
# (the plain flank strip that lifted dark paint below each armpit is gone. The drawing runs to the outline everywhere.)


def lum(a):
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def garment_guess(rgb):
    # painted garment = darker or saturated than the faint body / white template background
    f = rgb.astype(float)
    mx, mn = f.max(-1), f.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    return (lum(f) < 185) | (sat > 0.35)


def register(gen_big, mask_crop):
    best = None
    for s in np.linspace(0.94, 1.06, 13):
        w, h = round(CW * s), round(CH * s)
        g = np.array(gen_big.resize((w, h), Image.LANCZOS))
        guess = garment_guess(g)
        for dy in range(-24, 25, 3):
            for dx in range(-24, 25, 3):
                # place g so its centre lands at crop centre + (dx,dy)
                ox, oy = (CW - w) // 2 + dx, (CH - h) // 2 + dy
                canvas = np.zeros((CH, CW), bool)
                ys0, xs0 = max(0, oy), max(0, ox)
                ys1, xs1 = min(CH, oy + h), min(CW, ox + w)
                canvas[ys0:ys1, xs0:xs1] = guess[ys0 - oy:ys1 - oy, xs0 - ox:xs1 - ox]
                inter = (canvas & mask_crop).sum()
                iou = inter / max(1, (canvas | mask_crop).sum())
                if best is None or iou > best[0]:
                    best = (iou, s, dx, dy)
    # refine at 1 px around the best
    iou0, s0, dx0, dy0 = best
    for s in np.linspace(s0 - 0.01, s0 + 0.01, 5):
        w, h = round(CW * s), round(CH * s)
        g = np.array(gen_big.resize((w, h), Image.LANCZOS))
        guess = garment_guess(g)
        for dy in range(dy0 - 3, dy0 + 4):
            for dx in range(dx0 - 3, dx0 + 4):
                ox, oy = (CW - w) // 2 + dx, (CH - h) // 2 + dy
                canvas = np.zeros((CH, CW), bool)
                ys0, xs0 = max(0, oy), max(0, ox)
                ys1, xs1 = min(CH, oy + h), min(CW, ox + w)
                canvas[ys0:ys1, xs0:xs1] = guess[ys0 - oy:ys1 - oy, xs0 - ox:xs1 - ox]
                iou = (canvas & mask_crop).sum() / max(1, (canvas | mask_crop).sum())
                if iou > best[0]:
                    best = (iou, s, dx, dy)
    return best


def segments(row, minlen=3):
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    st, en = np.where(d == 1)[0], np.where(d == -1)[0] - 1
    return [(int(a), int(b)) for a, b in zip(st, en) if b - a + 1 >= minlen]


def _track_smooth(rows, half):
    # rows: {y: [value, ...]}; per (y, j), the median of the j-th value of the rows within +-half that have the same
    # count of values and whose value is within 12 px, then the mean of those medians over the same window (
    # cut positions and drawn gap ends picked per row jumped, so the closed gap and the edges it moves went jagged)
    def pass_(src, fn):
        out = {}
        for y, vals in src.items():
            nv = []
            for j, v in enumerate(vals):
                w = [src[z][j] for z in range(y - half, y + half + 1)
                     if z in src and len(src[z]) == len(vals) and abs(src[z][j] - v) <= 12]
                nv.append(fn(w) if w else v)
            out[y] = nv
        return out
    return pass_(pass_(rows, lambda w: float(np.median(w))), lambda w: float(np.mean(w)))


def fit_rows(rgb, painted, mask):
    # Waist fit: the drawing's own edge often sits inside
    # the template mask (a pinched waist beside the sash/belt, short sleeves at the gap). Per row, each
    # mask segment [L,R] (shoulders-and-sleeves above the armpits; sleeve / torso / sleeve below) is
    # matched with the painted run(s) over it [l,r]; each edge is moved onto the mask edge by a
    # horizontal warp eased to zero FIT_BAND px inward (the middle of the drawing is untouched). Edge
    # offsets are median- then mean-smoothed (EDGE_MEAN) along each edge track so outlines stay straight and even.
    # Where the drawing has a gap the mask closes, the trimmed drawn gap ends (and so the cut positions between
    # them) are smoothed along the gap's rows first (CUT_SMOOTH), so the closed gap follows a smooth line.
    H, W = mask.shape
    closed = np.zeros_like(mask)
    raw = {}  # (y, L, R) -> [dl, dr] (None when the side is merged with a neighbour or missing)
    splits = {}  # i-th mask segment -> {y: trimmed drawn runs flattened [a0, a1, b0, b1, ...]}
    split_info = {}
    for y in range(H):
        ms = segments(mask[y])
        if not ms:
            continue
        ps = segments(painted[y])
        for i, (L, R) in enumerate(ms):
            ov = [p for p in ps if p[1] >= L and p[0] <= R]
            if not ov:
                continue
            prevR = ms[i - 1][1] if i else -1
            nextL = ms[i + 1][0] if i + 1 < len(ms) else W
            big = [p for p in ov if p[1] - p[0] >= 6] or ov
            if len(big) > 1:
                # the drawing has a gap (e.g. its armpit gap starts higher or is wider than the template's)
                # where the mask is solid: split the mask segment at the drawn gaps' midpoints so each drawn
                # run closes onto its half of the gap. Each drawn run's own gap outline (ink core and its neutral
                # antialiasing) is trimmed off its gap-facing edge first, so no line is dragged into the closed gap.
                fr = rgb[y].astype(float)
                lr, cr = lum(fr), fr.max(-1) - fr.min(-1)
                inkish = lambda x: lr[x] < 45 or cr[x] < 12
                tb = []
                for j, p in enumerate(big):
                    a0, a1 = p
                    if j:
                        k = 0
                        while k < 14 and a0 < a1 - 4 and inkish(a0):
                            a0 += 1; k += 1
                    if j < len(big) - 1:
                        k = 0
                        while k < 14 and a1 > a0 + 4 and inkish(a1):
                            a1 -= 1; k += 1
                    tb.append((a0, a1))
                splits.setdefault(i, {})[y] = [float(v) for p in tb for v in p]
                split_info[(i, y)] = (L, R, prevR, nextL)
                continue
            l, r = min(p[0] for p in ov), max(p[1] for p in ov)
            dl = l - L if l > prevR else None   # painted run crosses into the gap toward the neighbour: unknown
            dr = r - R if r < nextL else None
            raw[(y, L, R)] = [dl, dr]
    for i, rows in splits.items():
        # only the inner (gap-facing) run ends are smoothed here; the outer ends are left to the edge fit
        sm = _track_smooth({y: v[1:-1] for y, v in rows.items()}, CUT_SMOOTH)
        for y, v in rows.items():
            L, R, prevR, nextL = split_info[(i, y)]
            v = [v[0]] + sm[y] + [v[-1]]
            big = [(v[k], v[k + 1]) for k in range(0, len(v), 2)]
            cuts = [int(round((a[1] + b[0]) / 2)) for a, b in zip(big, big[1:])]
            for a, b in zip(big, big[1:]):
                closed[y, max(0, int(np.floor(a[1])) - 10):int(np.ceil(b[0])) + 11] = True
            subs = list(zip([L] + [c + 1 for c in cuts], cuts + [R]))
            for j, ((sL, sR), p) in enumerate(zip(subs, big)):
                if sR - sL < 4:
                    continue
                dl = (p[0] - sL) if j else (p[0] - sL if p[0] > prevR else None)
                dr = (p[1] - sR) if j < len(big) - 1 else (p[1] - sR if p[1] < nextL else None)
                raw[(y, sL, sR)] = [dl, dr]
    keys = sorted(raw)
    byrow = {}
    for k in keys:
        byrow.setdefault(k[0], []).append(k)
    med = {}
    for (y, L, R) in keys:
        sm = []
        for side, E in ((0, L), (1, R)):
            vals = []
            for yy in range(y - 6, y + 7):
                for k in byrow.get(yy, []):
                    e = k[1] if side == 0 else k[2]
                    v = raw[k][side]
                    if abs(e - E) <= 6 and v is not None and abs(v) <= FIT_MAX:
                        vals.append(v)
            sm.append(float(np.median(vals)) if len(vals) >= 3 else 0.0)
        med[(y, L, R)] = sm
    # mean pass along the same edge tracks: the median alone steps between plateaus (a blocky stretched edge)
    fin = {}
    for (y, L, R) in keys:
        sm = []
        for side, E in ((0, L), (1, R)):
            vals = [med[k][side] for yy in range(y - EDGE_MEAN, y + EDGE_MEAN + 1) for k in byrow.get(yy, [])
                    if abs((k[1] if side == 0 else k[2]) - E) <= 6]
            sm.append(float(np.mean(vals)) if vals else med[(y, L, R)][side])
        fin[(y, L, R)] = sm
    out = rgb.copy()
    newp = painted.copy()
    moved = 0
    maxd = 0
    xs = np.arange(W, dtype=float)
    for (y, L, R) in keys:
        dl, dr = fin[(y, L, R)]
        if abs(dl) < 0.5 and abs(dr) < 0.5:
            newp[y, L:R + 1] |= painted[y, L:R + 1]
            continue
        B = max(4.0, min(FIT_BAND, (R - L) / 2))
        x = xs[L:R + 1]
        src = x + dl * np.clip(1 - (x - L) / B, 0, 1) + dr * np.clip(1 - (R - x) / B, 0, 1)
        src = np.clip(src, 0, W - 1)
        x0 = np.floor(src).astype(int)
        x1 = np.minimum(x0 + 1, W - 1)
        t = (src - x0)[:, None]
        row = rgb[y].astype(float)
        out[y, L:R + 1] = np.round(row[x0] * (1 - t) + row[x1] * t).astype(np.uint8)
        newp[y, L:R + 1] = True
        moved += 1
        maxd = max(maxd, abs(dl), abs(dr))
    # the drawn gap's own light antialiasing stretched into the closed gap: take the nearest painted colour
    f = out.astype(float)
    zone = ndimage.binary_dilation(closed, iterations=3) & mask
    chroma = f.max(-1) - f.min(-1)
    pale = zone & (lum(f) > 140) & (chroma < 30)
    # background white, and the thin pale antialiasing streaks of the drawn gap's outline (thin: gone
    # after a 2 px opening; broad pale paint such as steel or mail highlights survives the opening)
    light = (zone & (lum(f) > 215) & (chroma < 22)) | (pale & ~ndimage.binary_opening(pale, iterations=2))
    if light.any():
        _, (iy, ix) = ndimage.distance_transform_edt(light, return_indices=True)
        out[light] = out[iy[light], ix[light]]
    return out, newp, "%d rows, max %.1f px, %d light gap px refilled" % (moved, maxd, int(light.sum()))


def warm_highlights(rgb, alpha):
    # Skin-safe highlights (importer coverageEveryFrame reads r>170, r-b>60, r-g>20 as skin): only pixels that
    # would actually read as skin are scaled (same hue) to r = 170. (Jacket B, swag-kungfu-02
    # tools/polish_kf.py folded in): the former rule (r>170 within 6 px of any warm paint) also hit a cream
    # trim's warm shade and turned it blotchy grey-tan.
    f = rgb.astype(float)
    sel = alpha & (f[..., 0] > 170) & (f[..., 0] - f[..., 2] > 60) & (f[..., 0] - f[..., 1] > 20)
    rgb[sel] = np.round(f[sel] * (170.0 / f[sel][:, :1])).astype(np.uint8)
    return int(sel.sum())


BAND_EXTEND = True  #: belt / sash ends that stop short of the torso side outline run on to it
BAND_REACH = 40     # px: largest fabric gap between a band end and the side outline that is closed
BAND_H = (12, 100)  # rows: band height range (thinner = an ink line, taller = a plate or a mail field)


def _band_side(rgb, alpha, tl, rows, e, nd, ink, borrow=None):
    # One side of a detected band, drawn as the LEFT end (the right end is passed in mirrored).
    # rows: band rows; e[y]: the band run's outer end per row; tl[y]: the torso's left mask edge per row.
    # Returns (texels repainted, profile) with profile = the band's cross-section used, "nowin" when this end has no
    # clean body near its cap (its studs and a crossing strap fill it; then the other end's cross-section is passed
    # in as `borrow` and joined where it matches this end's own body best), or (0, None) for no band end.
    f = rgb.astype(float)
    chroma = f.max(-1) - f.min(-1)
    H, W = alpha.shape
    y0, y1 = rows[0], rows[-1]
    ec = min(e[y] for y in rows)
    # outline inner edge per row: walk out from the band end over the fabric to the first ink / transparent texel
    xo, gaps, fab, fabc = {}, [], [], []
    for y in range(y0 - 2, y1 + 3):
        x = min(e.get(y, ec), ec) - 1
        while x >= tl[y] and alpha[y, x] and not ink[y, x] and x > ec - BAND_REACH - 2:
            x -= 1
        xo[y] = x + 1
        if y in e:
            gaps.append(e[y] - (x + 1))
            fab.extend(chroma[y, x + 1:e[y]] >= 25)
            fabc.extend(f[y, x + 1:e[y]])
    gap = float(np.median(gaps))
    if not (3 <= gap <= BAND_REACH) or max(gaps) > BAND_REACH + 1:
        return 0, None
    # the gap is another material: coloured fabric, not more of the neutral band (mail, steel, a strap's own end)
    if np.mean(fab) < 0.8:
        return 0, None
    # rounded end: the band's top or bottom rows stop inside its middle rows' end (not a straight cut)
    if max(min(e[y] for y in rows[:3]), min(e[y] for y in rows[-3:])) - ec < 2:
        return 0, None
    # band detail enclosed by the band (studs, rivets): chromatic texels not connected to the fabric outside the band
    zone = np.zeros_like(alpha)
    zone[y0 - 2:y1 + 3, ec:ec + 90] = True
    chrom = alpha & (chroma >= 25) & ~nd
    lab, n = ndimage.label(chrom & zone)
    outer = np.zeros_like(alpha)
    for y in range(y0 - 2, y1 + 3):
        outer[y, xo[y]:ec] = True
    outer[[y0 - 2, y1 + 2], ec:ec + 90] = True
    touching = set(np.unique(lab[outer & (lab > 0)]))
    fabm = np.median(np.array(fabc), axis=0)  # the fabric's colour (a sliver of it trapped by the cap is no detail)
    det = [i for i in range(1, n + 1) if i not in touching and (lab == i).sum() >= 12
           and np.linalg.norm(np.median(f[lab == i], axis=0) - fabm) > 60]
    detail = np.isin(lab, det) & (lab > 0)
    keep = ndimage.binary_dilation(detail, iterations=2)
    # sample window: the first band body columns inward of the cap that are full-height, stud-free and uniform
    hmax = float(np.median([int(nd[y0:y1 + 1, x].sum()) for x in range(ec, ec + 60)]))  # typical band height
    lumv = lum(f)
    xw = None
    for x in range(ec + 2, ec + 85):
        cols = range(x, x + 5)
        if any(keep[y0:y1 + 1, c].any() for c in cols):
            continue
        if any(not 0.9 * hmax <= nd[y0:y1 + 1, c].sum() <= 1.08 * hmax for c in cols):
            continue  # short = a stud's or buckle's column, tall = a strap crossing the band
        d = max(np.abs(lumv[y0:y1 + 1, c] - lumv[y0:y1 + 1, x]).mean() for c in cols)
        if d < 6:
            xw = x
            break
    if xw is not None:  # settle past the cap's last faint line: the most uniform start within the next 6 columns
        dd = {x: max(np.abs(lumv[y0:y1 + 1, c] - lumv[y0:y1 + 1, x]).mean() for c in range(x, x + 5))
              for x in range(xw, xw + 7) if not keep[y0:y1 + 1, x:x + 5].any()
              and all(0.9 * hmax <= nd[y0:y1 + 1, c].sum() <= 1.08 * hmax for c in range(x, x + 5))}
        xw = min(dd, key=lambda x: (round(dd[x]), x))
    if xw is None and borrow is None:
        return 0, "nowin"
    if xw is None:
        prof, slope = borrow["prof"], borrow["slope"]
        hp = len(prof) - 1
        # join where this end's own body matches the cross-section best (lower 70% of it: a strap may cross the
        # band's top), at the best vertical offset from the column's bottom edge; nearest the cap among the best
        lp = lum(prof)[int(0.3 * hp):]
        cands = []
        for x in range(ec + 2, ec + 85):
            if keep[y0 - 2:y1 + 3, x].any() or nd[y0:y1 + 1, x].sum() < 0.9 * hmax:
                continue
            b_ = int((np.where(nd[y0 - 2:y1 + 3, x])[0] + y0 - 2)[-1]) + 1
            for o in range(-3, 4):
                top = b_ + o - hp
                if top < 2 or b_ + o > H - 3:
                    continue
                d = float(np.abs(lumv[top + int(0.3 * hp):b_ + o + 1, x] - lp).mean())
                cands.append((d, x, top, b_ + o))
        if not cands:
            return 0, None
        dmin = min(c[0] for c in cands)
        if dmin > 8:
            return 0, None
        best = min((c for c in cands if c[0] <= dmin + 1.5), key=lambda c: (c[1], c[0]))
        _, xw, pt, pb = best
    else:
        prof = None
    # the band's own top/bottom edge slope over the body past the window (a sagging belt keeps sagging outward)
    tops, bots, xs = [], [], []
    for x in range(xw, xw + 30):
        col = np.where(nd[y0 - 2:y1 + 3, x])[0]
        if len(col) >= 0.9 * hmax and not keep[y0:y1 + 1, x].any():
            tops.append(col[0]); bots.append(col[-1]); xs.append(x)
    if prof is None:
        slope = 0.0
    if prof is None and len(xs) >= 8:
        slope = float(np.clip((np.polyfit(xs, tops, 1)[0] + np.polyfit(xs, bots, 1)[0]) / 2, -0.3, 0.3))
    col = np.where(nd[y0 - 2:y1 + 3, xw])[0] + y0 - 2
    if prof is None:
        pt, pb = int(col[0]) - 1, int(col[-1]) + 1  # band rows in the window column, one antialias row each side
    # a band crosses fabric: the window's body has coloured fabric right above or below it (a mail field or plate
    # cut into rows by the detector has more of itself on both sides; a strap may cross the belt on one side)
    if pt < 4 or pb > H - 5:
        return 0, None
    if max(np.mean(chroma[pt - 3:pt + 1, xw:xw + 5] >= 25), np.mean(chroma[pb:pb + 4, xw:xw + 5] >= 25)) < 0.6:
        return 0, None
    if prof is None:
        prof = np.median(f[pt:pb + 1, xw:xw + 5], axis=1)  # (rows, 3)
    out = rgb.copy()
    painted = np.zeros_like(alpha)
    XF = 6  # columns past the joint over which the cross-section cross-fades into the band's own body
    for x in range(min(xo.values()), xw + XF):
        sh = slope * (x - xw)  # source row = dest row - sh
        w = 1.0 if x < xw else 1.0 - (x - xw + 1) / (XF + 1)
        for y in range(pt - 4, pb + 5):
            if y not in xo or x < xo[y] or keep[y, x]:
                continue
            s = y - sh - pt
            if s < 0 or s > pb - pt:
                continue
            i0 = int(np.floor(s)); i1 = min(i0 + 1, pb - pt); t = s - i0
            c = prof[i0] * (1 - t) + prof[i1] * t
            out[y, x] = np.round(c * w + f[y, x] * (1 - w)).astype(np.uint8)
            painted[y, x] = True
    # the old cap left outside the continued band (its rounded end, ink corners): the nearest fabric colour
    reg = np.zeros_like(alpha)
    for y in range(y0 - 2, y1 + 3):
        reg[y, xo[y]:xw] = True
    oldcap = reg & ~painted & ~keep & (nd | (chroma < 25))
    if oldcap.any():
        src = reg & ~painted & ~keep & ~oldcap
        src |= ~reg & alpha & ~nd & (chroma >= 25)
        _, (iy, ix) = ndimage.distance_transform_edt(~src, return_indices=True)
        out[oldcap] = out[iy[oldcap], ix[oldcap]]
    rgb[...] = out
    return int(painted.sum() + oldcap.sum()), {"prof": prof, "slope": slope}


def extend_bands(rgb, alpha, mask):
    #: a dark horizontal band (belt,
    # dark sash) whose rounded ends stop short of the torso's side outline is continued out to that outline from its
    # own body rows near the cap (top/bottom edges, inner shading and trim lines, sagging with the band), and the end
    # cap is removed, so it runs under the outline like a belt wrapping round. Studs, buckle and centre detail stay.
    # Detection is from the art: per row, the neutral (dark with its light bevel) texels of the torso (mask segment over the centre column;
    # above the armpits, the first split row's torso) merged across the buckle / studs must span 60% of the torso
    # between the side outlines, over 12-100 consecutive rows, with ends that round in at the band's top and bottom.
    H, W = alpha.shape
    f = rgb.astype(float)
    L, chroma = lum(f), f.max(-1) - f.min(-1)
    nd = alpha & (L < 130) & (chroma < 25)  # band material: neutral paint, its light bevel included
    ink = (L < 26) & (chroma < 14)
    xs = np.where(alpha.any(0))[0]
    cx = (xs[0] + xs[-1]) // 2
    torso = {}
    for y in range(H):
        segs = [s for s in segments(mask[y]) if s[0] <= cx <= s[1]]
        if segs:
            torso[y] = segs[0]
    split = [y for y in sorted(torso) if len(segments(mask[y])) >= 3]
    if not split:
        return ""
    apex = split[0]
    span = {}
    for y in torso:
        tL, tR = torso[apex] if y < apex else torso[y]
        a, b = tL + OUTLINE_W, tR - OUTLINE_W
        if b - a < 40:
            continue
        runs = segments(nd[y, a:b + 1], 1)
        if not runs:
            continue
        merged = [list(runs[0])]
        for s in runs[1:]:
            if s[0] - merged[-1][1] <= 0.35 * (b - a):
                merged[-1][1] = s[1]
            else:
                merged.append(list(s))
        best = max(merged, key=lambda r: r[1] - r[0])
        l, r = best[0] + a, best[1] + a
        while l > 0 and nd[y, l - 1]:  # a band that runs on past the torso interior (onto the outline, a sleeve)
            l -= 1
        while r < W - 1 and nd[y, r + 1]:
            r += 1
        if l < cx < r and min(r, b) - max(l, a) + 1 >= 0.6 * (b - a) and nd[y, l:r + 1].mean() >= 0.45:
            span[y] = (l, r, tL, tR)
    # bands = runs of consecutive qualifying rows
    groups, cur = [], []
    for y in sorted(span):
        if cur and y != cur[-1] + 1:
            groups.append(cur); cur = []
        cur.append(y)
    if cur:
        groups.append(cur)
    notes = []
    for g in groups:
        if not (BAND_H[0] <= len(g) <= BAND_H[1]) or g[0] < 2 or g[-1] > H - 3:
            continue
        body = np.concatenate([L[y, span[y][0]:span[y][1] + 1][nd[y, span[y][0]:span[y][1] + 1]] for y in g])
        if np.median(body) >= 80:  # a dark band (belt, dark sash), not a light steel plate
            continue
        done, res, args = [], {}, {}
        orig_r = rgb.copy()
        for side in ("L", "R"):
            if side == "L":
                im, al, nn, ik = rgb, alpha, nd, ink
                e = {y: span[y][0] for y in g}
                tl = {y: (span[y][2] if y in span else span[g[0] if y < g[0] else g[-1]][2]) for y in range(g[0] - 2, g[-1] + 3)}
            else:
                im, al, nn, ik = rgb[:, ::-1].copy(), alpha[:, ::-1], nd[:, ::-1], ink[:, ::-1]
                e = {y: W - 1 - span[y][1] for y in g}
                tl = {y: W - 1 - (span[y][3] if y in span else span[g[0] if y < g[0] else g[-1]][3]) for y in range(g[0] - 2, g[-1] + 3)}
            args[side] = (im, al, tl, g, e, nn, ik)
            res[side] = _band_side(*args[side])
        for side, other in (("L", "R"), ("R", "L")):
            if res[side][1] == "nowin" and isinstance(res[other][1], dict):
                res[side] = _band_side(*args[side], borrow=res[other][1])
                if res[side][0]:
                    done.append("%s from %s's cross-section" % (side, other))
        for side in ("L", "R"):
            n = res[side][0]
            if n and side == "R":  # the right end was painted on a mirrored copy: bring its changes back
                mir = args[side][0][:, ::-1]
                ch = (mir != orig_r).any(-1)
                rgb[ch] = mir[ch]
            if n:
                done.append("%s %d px" % (side, n))
        if done:
            notes.append("rows %d-%d: %s" % (g[0], g[-1], ", ".join(done)))
    return "; ".join(notes)


def polish(gen_path, kind, out_path):
    mask = np.array(Image.open(MASKS[kind]).convert("L")) > 127
    H, W = mask.shape
    mask_crop = mask[CROP[1]:CROP[3], CROP[0]:CROP[2]]
    gen = Image.open(gen_path).convert("RGB")
    iou, s, dx, dy = register(gen, mask_crop)
    w, h = round(CW * s), round(CH * s)
    g = gen.resize((w, h), Image.LANCZOS)
    ox, oy = CROP[0] + (CW - w) // 2 + dx, CROP[1] + (CH - h) // 2 + dy
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    canvas.paste(g, (ox, oy))
    rgb = np.array(canvas)
    # silhouette = allowed mask AND the generation's own painted area (where the image generator left the template's
    # white / faint body inside the mask, e.g. an inset arm-gap edge, the item stops at its own outline)
    f = rgb.astype(float)
    bgish = (lum(f) > 215) & ((f.max(-1) - f.min(-1)) < 22)
    painted = ndimage.binary_fill_holes(ndimage.binary_opening(~bgish, iterations=2))
    fit = None
    if FIT:
        rgb, painted, fit = fit_rows(rgb, painted, mask)
    alpha = mask & painted
    lab, n = ndimage.label(alpha)
    if n > 1:  # keep the main piece(s), drop crumbs under 200 px
        sizes = ndimage.sum(alpha, lab, range(1, n + 1))
        alpha = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 200])
    # the template's coverage is the item's coverage: mask texels the drawing stops short of (a hem row, a
    # cuff corner) take the nearest drawn colour; the outline band below then lands on the mask edge
    short = mask & ~alpha
    leftover_px = int(short.sum())
    if short.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~alpha, return_indices=True)
        rgb[short] = rgb[iy[short], ix[short]]
        alpha = alpha | short
    # outline colour = the generation's own darkest common colour along the edge
    band = alpha & ~ndimage.binary_erosion(alpha, iterations=OUTLINE_W)
    edge = rgb[alpha & ~ndimage.binary_erosion(alpha, iterations=4)].astype(float)
    dark = edge[lum(edge) <= np.percentile(lum(edge), 30)]
    ink = np.median(dark, axis=0).astype(np.uint8)
    rgb[band] = ink
    # colour rule: warm saturated tones (red/orange/gold/bronze/brown) keep red <= 150. Scale the whole
    # RGB of such pixels by 150/r (same hue, darker). Light low-chroma cream (r-b <= 45) is left alone.
    f = rgb.astype(float)
    warm = (f[..., 0] > 150) & (f[..., 0] - f[..., 2] > 45) & (f[..., 0] >= f[..., 1]) & ((f.max(-1) - f.min(-1)) / np.maximum(f.max(-1), 1) > 0.3)
    if CLAMP:
        rgb[warm] = np.round(f[warm] * (150.0 / f[warm][:, :1])).astype(np.uint8)
    hl = warm_highlights(rgb, alpha)
    if BAND_EXTEND:
        bands = extend_bands(rgb, alpha, mask)
        if bands:
            fit = "%s; band ends extended: %s" % (fit, bands)
    out = np.zeros((H, W, 4), np.uint8)
    out[..., :3] = rgb
    out[alpha, 3] = 255
    out[~alpha] = 0
    leftover = mask & ~alpha  # 0 now; leftover_px is what was filled
    Image.fromarray(out).save(out_path)
    return iou, s, dx, dy, tuple(int(v) for v in ink), leftover_px, fit, hl


if __name__ == "__main__":
    import json
    specs = {c["id"]: c for c in json.load(open(ROOT / "tools/concepts.json", encoding="utf-8"))}
    for cid in sys.argv[1:]:
        d = ROOT / cid
        (d / "final").mkdir(exist_ok=True)
        for gp in sorted((d / "output").glob("gen-*.png")):
            out = d / "final" / (gp.stem + "-garment.png")
            r = polish(gp, specs[cid]["template"], out)
            print(cid, gp.name, Image.open(gp).size, "iou=%.3f scale=%.3f dx=%d dy=%d ink=%s filled=%d fit=%s warmHighlights=%d" % r)
