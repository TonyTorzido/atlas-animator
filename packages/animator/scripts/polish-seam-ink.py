# Interior seam polish for body-derived garments (armour /15).
#
#   python polish-seam-ink.py polish in.png out.png [--rows 600:860] [--mask mask.png]
#   python polish-seam-ink.py check texture.png mask.png --rect L,T,W,H [--fabric r,g,b] [--ink r,g,b] [--domain d.json]
#
# polish: repaints interior outline-coloured seam lines (the arm/torso seam the artist drew in outline ink) with the
# surrounding fabric; the silhouette outline (within SIL px of transparency) and line work outside --rows (collar, belt)
# are kept. The ink colour is the art's own silhouette outline colour (mode of the outline band), not a fixed value.
# Shading that HUGS a removed seam (a darker band drawn against the seam line, the artist's shadow of it) is treated
# like the seam itself: within HUG px of the
# removed line, darker-than-fabric paint is eased toward the fabric, fully at the line and back to the art's own
# shade at HUG px (smoothstep), so no shade island remains where the line was. Then every seam texel takes the colour
# of the nearest kept fabric texel. --mask writes the removed seam texels (white) for the check.
#
# check: garment-interior darkness near removed seams, per material (--fabric = the single-material form). For the painted texture (garmentImport's <name>-texture.png,
# rect = the report's paint rect in canvas px), the luminance deficit below the fabric is averaged in windows of
# WIN px slid along the removed seam (texels within NEAR px of it), and compared with the same mean over the whole
# garment interior. Fails (exit 1) when a window is darker than the interior mean by more than TOL: shading left
# along a removed seam reads as a smudge.
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

SIL = 8      # px from transparency: the silhouette outline band (kept)
HUG = 12     # px from the removed seam over which hugging shade is eased back to the art (2 seam widths)
NEAR = 6     # px band beside the removed seam measured by the check
WIN = 12     # px window along the seam for the check
INK_TOL = 30  # sum of abs RGB: a texel this close to --ink is line work (as polish() reads ink)
TOL = 6.0    # luminance: allowed excess darkness near a removed seam over the interior mean
PATTERN_REACH = 4  # px: texels this close to a dark-pattern material (mail, lamellar) are read in default mode


def lum(c):
    return 0.299 * c[..., 0] + 0.587 * c[..., 1] + 0.114 * c[..., 2]


def outline_ink(im, a):
    band = a & (ndimage.distance_transform_edt(a) <= 3)
    cols, counts = np.unique(im[band][:, :3], axis=0, return_counts=True)
    dark = lum(cols.astype(float)) < 80
    cols, counts = cols[dark], counts[dark]
    return cols[np.argmax(counts)]


def polish(src, dst, rows=(600, 860), mask_out=None):
    im = np.array(Image.open(src).convert("RGBA")).astype(np.int32)
    a = im[..., 3] > 0
    inkc = outline_ink(im, a)
    ink = (np.abs(im[..., :3] - inkc).sum(-1) < 30) & a
    dist = ndimage.distance_transform_edt(a)
    H, W = a.shape
    yy = np.arange(H)[:, None].repeat(W, 1)
    seam = ink & (dist > SIL) & (yy > rows[0]) & (yy < rows[1])
    seam = ndimage.binary_dilation(seam, iterations=1) & ink
    out = im.copy()
    fabric = a & ~ink
    # fabric tone: the most common non-ink colour of the garment interior
    cols, counts = np.unique(im[fabric & (dist > SIL)][:, :3], axis=0, return_counts=True)
    fab = cols[np.argmax(counts)].astype(np.float64)
    # shading hugging the removed seam: eased toward the fabric by distance to the line
    dseam = ndimage.distance_transform_edt(~seam)
    deficit = lum(fab[None, :]) [0] - lum(im[..., :3].astype(np.float64))
    hug = fabric & (dseam <= HUG) & (deficit > 0) & (dist > SIL)
    u = np.clip((dseam - 1) / (HUG - 1), 0, 1)
    keep = u * u * (3 - 2 * u)  # share of the art's own shade kept
    k = (1 - keep)[..., None]
    eased = im[..., :3] + (fab[None, None, :] - im[..., :3]) * k
    out[..., :3] = np.where(hug[..., None], np.rint(eased).astype(np.int32), out[..., :3])
    # each seam texel takes the colour of the nearest kept fabric texel (after the easing)
    src_m = fabric
    _, (iy, ix) = ndimage.distance_transform_edt(~src_m, return_indices=True)
    out[seam] = out[iy[seam], ix[seam]]
    print("ink", tuple(int(v) for v in inkc), "fabric", tuple(int(v) for v in fab), "seam repainted", int(seam.sum()), "hugging shade eased", int(hug.sum()))
    Image.fromarray(out.astype(np.uint8)).save(dst)
    if mask_out:
        Image.fromarray((seam * 255).astype(np.uint8)).save(mask_out)


MAT_SHARE = 0.05  # a colour covering at least this share of the interior is a material base or tone (0.15 left the breastplate side-shade tone out, so its 1-2 px edge with the steel read as darkness; both smudge controls fail unchanged at 0.05)
BLEND = 10.0     # RGB distance: a texel this close to the segment between two material bases may be their edge blend
BLEND_PX = 2     # px: ... if it also lies this close to texels of both materials (an antialiased edge, not a band)


def edge_blend(rgb, bases, label):
    """Texels whose colour lies on the RGB segment between two material bases (strictly between them,
    within BLEND) AND within BLEND_PX of both materials' own texels: the 1-2 px antialiased edge where two
    materials meet, not paint. A band (wider than the edge) or a smudge darker than both materials is
    never excused."""
    out = np.zeros(rgb.shape[:-1], dtype=bool)
    cand_all = np.zeros_like(out)
    seg = {}
    for i in range(len(bases)):
        for j in range(i + 1, len(bases)):
            a, b = bases[i], bases[j]
            ab = b - a
            t = ((rgb - a) * ab).sum(-1) / float((ab * ab).sum())
            p = a + np.clip(t, 0, 1)[..., None] * ab
            seg[(i, j)] = (np.sqrt(((rgb - p) ** 2).sum(-1)) <= BLEND) & (t > 0.05) & (t < 0.95)
            cand_all |= seg[(i, j)]
    for (i, j), c in seg.items():
        near_i = ndimage.distance_transform_edt(~((label == i) & ~cand_all)) <= BLEND_PX
        near_j = ndimage.distance_transform_edt(~((label == j) & ~cand_all)) <= BLEND_PX
        out |= c & near_i & near_j
    return out


def materials(tex, interior):
    """Material base colours: the exact colours covering >= MAT_SHARE of the interior (most common first;
    at least the most common one). Every interior texel belongs to its nearest base in RGB, so a dark
    smudge or line drawn on a material counts with that material (it is nearer to it than to a lighter one)."""
    cols, counts = np.unique(tex[interior][:, :3].astype(np.int32), axis=0, return_counts=True)
    order = np.argsort(-counts)
    total = counts.sum()
    bases = [cols[i] for i in order if counts[i] >= MAT_SHARE * total] or [cols[order[0]]]
    return np.array(bases, dtype=np.float64)


def domain_seam_config(path):
    """The domain's "seamCheck" block (): {"ink": [r,g,b] (the item's outline colour), "materials":
    [{"name", "rgb": [r,g,b] (the material's nominal base colour), "pattern": "plain" | "dark"}]}. "dark" marks a
    material whose own pattern is dark line work (mail rings, lamellar plate rows): the ink override does not apply
    there, its texels at luminance <= 60 stay out of the interior as in the default mode. "plain" materials (cloth,
    leather, lacquer) are read with the ink override, so a near-black plain fabric is still measured."""
    import json
    d = json.load(open(path, encoding="utf-8")).get("seamCheck") or {}
    mats = [(np.array(m["rgb"], dtype=np.float64), m.get("pattern", "plain")) for m in d.get("materials", [])]
    ink = tuple(d["ink"]) if d.get("ink") else None
    return ink, mats


def check(texture, mask, rect, fabric=None, ink=None, mats=None):
    """Seam darkness. Default (): per material. The interior is split into materials (colour
    clusters, see materials()); each material's near-seam texels are compared with that SAME material's
    interior (its own base luminance and its own mean deficit), so a two-material item (steel plate over
    cloth sleeves meeting on the seam) is judged steel against steel and cloth against cloth, and a dark
    band on either side still fails. --fabric r,g,b keeps the single-material check ().
    --ink r,g,b (dark items): line work is the texels within INK_TOL (sum of abs RGB) of that colour,
    instead of everything at luminance <= 60, so a near-black fabric (the kung-fu jacket, lum 47) is measured
    instead of skipped. Without it the check warns when it cannot see most of the interior.
    mats (-domain, the domain's seamCheck materials): the ink override applies per material, only on
    "plain" materials; texels within PATTERN_REACH px of paint whose nearest configured material is a "dark" pattern
    (mail, lamellar) are read in the default mode (luminance > 60), so the rings' own dark gaps are not counted as
    seam darkness."""
    L, T, W, H = rect
    tex = np.array(Image.open(texture).convert("RGBA")).astype(np.float64)
    m = np.array(Image.open(mask).convert("L"))[T:T + H, L:L + W] > 127
    a = tex[..., 3] > 0
    tl = lum(tex[..., :3])
    dist = ndimage.distance_transform_edt(a)
    inner = a & (dist > SIL)
    if ink is not None:
        interior = inner & (np.abs(tex[..., :3] - np.array(ink, dtype=np.float64)).sum(-1) >= INK_TOL)  # not line work
        if mats and any(p == "dark" for _, p in mats):
            cfg = np.array([c for c, _ in mats])
            near_cfg = np.argmin(((tex[..., None, :3] - cfg[None, None]) ** 2).sum(-1), axis=-1)
            dark_ids = [i for i, (_, p) in enumerate(mats) if p == "dark"]
            # the pattern's region: its lighter paint (luminance > 60, the rings themselves) grown by PATTERN_REACH
            patt = inner & np.isin(near_cfg, dark_ids) & (tl > 60)
            patt = ndimage.binary_dilation(patt, iterations=PATTERN_REACH) & inner
            interior = np.where(patt, inner & (tl > 60), interior)
    else:
        interior = inner & (tl > 60)  # not the outline ink, not trim ink
        blind = 1 - interior.sum() / max(1, inner.sum())
        if blind > 0.25:
            print(f"seam darkness: WARNING {blind:.0%} of the interior is at luminance <= 60 and not measured "
                  f"(dark item): pass --ink <outline colour>")
    if fabric is not None:
        bases = np.array([fabric], dtype=np.float64)
        label = np.zeros(a.shape, dtype=np.int32)
    else:
        bases = materials(tex, interior)
        d2 = ((tex[..., None, :3] - bases[None, None, :, :]) ** 2).sum(-1)
        label = np.argmin(d2, axis=-1)
        interior = interior & ~edge_blend(tex[..., :3], bases, label)
    blum = lum(bases)
    deficit = np.clip(blum[label] - tl, 0, None)
    dseam = ndimage.distance_transform_edt(~m)
    near = interior & (dseam <= NEAR)
    base = [float(deficit[interior & (label == k)].mean()) if (interior & (label == k)).any() else 0.0 for k in range(len(bases))]
    ys, xs = np.nonzero(m)
    worst = (-1e9, None, 0.0, 0)  # (excess over the material's bound, at, window deficit, material)
    for y0 in range(int(ys.min()), int(ys.max()) + 1, WIN // 2):
        for side in (xs < W / 2, xs >= W / 2):
            sel = side & (ys >= y0) & (ys < y0 + WIN)
            if not sel.any():
                continue
            x0, x1 = int(xs[sel].min()) - NEAR, int(xs[sel].max()) + NEAR + 1
            win = np.zeros_like(near)
            win[y0:y0 + WIN, max(0, x0):x1] = True
            for k in range(len(bases)):
                w = near & win & (label == k)
                if w.sum() < 10:
                    continue
                v = float(deficit[w].mean())
                if v - (base[k] + TOL) > worst[0]:
                    worst = (v - (base[k] + TOL), (L + (x0 + x1) // 2, T + y0 + WIN // 2), v, k)
    ok = worst[0] <= 0
    k = worst[3]
    mats = ", ".join(f"{tuple(int(c) for c in bases[i])} mean {base[i]:.1f}" for i in range(len(bases)))
    if worst[1] is None:
        print(f"seam darkness: materials [{mats}]; no near-seam window: PASS")
        return True
    print(f"seam darkness: materials [{mats}]; worst near-seam window {worst[2]:.1f} "
          f"({tuple(int(c) for c in bases[k])}) at {worst[1]}, bound {base[k] + TOL:.1f}: {'PASS' if ok else 'FAIL'}")
    return ok


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] not in ("polish", "check"):
        argv = ["polish"] + argv  # old call form: in.png out.png

    def opt(name, default=None):
        if name in argv:
            i = argv.index(name)
            v = argv[i + 1]
            del argv[i:i + 2]
            return v
        return default

    cmd = argv.pop(0)
    if cmd == "polish":
        rows = tuple(int(v) for v in opt("--rows", "600:860").split(":"))
        mask = opt("--mask")
        polish(argv[0], argv[1], rows, mask)
    else:
        rect = tuple(int(v) for v in opt("--rect").split(","))
        fab = opt("--fabric")
        fab = tuple(int(v) for v in fab.split(",")) if fab else None
        ink = opt("--ink")
        ink = tuple(int(v) for v in ink.split(",")) if ink else None
        dom = opt("--domain")
        mats = None
        if dom:
            dink, mats = domain_seam_config(dom)
            ink = ink or dink
        sys.exit(0 if check(argv[0], argv[1], rect, fab, ink, mats) else 1)
