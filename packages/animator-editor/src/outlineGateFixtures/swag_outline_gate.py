"""Outline-continuity gate for chest items: every garment piece's outline must be one
unbroken ink line wherever it shows, in every pose of the user-view sets.

    KIT_VIEW=turn00 python scripts/kit/swag_outline_gate.py --skin chest.jacket_b --out <dir> [--sets main,elbow,swing]
    (run from packages/animator; exit code 1 when the gate fails)

For every pose it renders the figure at 1.0 with the skin on, then each garment piece alone (the two sleeves, the torso panel).
Along each piece's edge (1 to 3 px inside its silhouette, where its 11 px outline band lies) every pixel where that piece is the
topmost thing drawn must be outline ink in the piece as deformed (a squeezed band, a seam or a cut end shows its cloth there). A run of non-ink edge pixels longer than MAX_BREAK px is a break (a gap, a stub end, a
seam). Writes gate.json (per pose and piece: breaks and the longest) and, for poses that fail, gate-<set>-<pose>.png with the
breaks marked in magenta.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

import kit_front_check as kf
import kit_canon as kc
import swag_sheet as ss

MAX_BREAK = 2.0          # px along the edge
INK_MAX = 40.0           # an ink pixel: every channel at most this (garment ink is 22,14,10; the darkest cloth tone is above it)
PIECES = ("shirt_sleeve_near", "shirt_sleeve_far", "shirt_torso")


def render(poses, tmp, rig, hide_all_but=None):
    doc = json.loads((Path(rig) / f"{kc.RIG_STEM}.anim.json").read_text())
    names = [s["name"] for s in doc["slots"]]
    P = poses
    if hide_all_but:
        P = {k: {**v, "hide": [n for n in names if n != hide_all_but]} for k, v in poses.items()}
    kf.render_poses(P, tmp, rig_dir=Path(rig))
    return [np.asarray(kf.frame(tmp, i)).astype(np.float32) for i in range(len(P))]


def edge_breaks(F, G):
    """(break count, longest break px, bad-pixel mask) for one piece G (rendered alone) inside the full frame F."""
    A = G[..., 3] > 127
    ring = A & ~ndimage.binary_erosion(A, iterations=3) & ndimage.binary_erosion(A, iterations=1)
    top = (np.abs(F[..., :3] - G[..., :3]).max(axis=2) < 40) & (F[..., 3] > 200)     # the piece is what shows (its antialiased
    ink = G[..., :3].max(axis=2) <= INK_MAX                                             # fringe blends a little with what is under it)
    bad = ring & top & ~ink
    lab, k = ndimage.label(bad, structure=np.ones((3, 3)))
    if k == 0:
        return 0, 0.0, bad
    out = np.zeros_like(bad)
    longest, n = 0.0, 0
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        comp = lab[sl] == i
        length = float(max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start))     # extent along the edge (the ring is 2 px thick)
        if length > MAX_BREAK:
            n += 1
            longest = max(longest, length)
            out[sl] |= comp
    return n, longest, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skin", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rig", default=str(kf.RIG_DIR))
    ap.add_argument("--sets", default="main,elbow,swing")
    a = ap.parse_args()
    orig = kf.sh

    def sh(cmd):
        if " render " in cmd:
            cmd = cmd + f" --skins body,{a.skin}"
        return orig(cmd)
    kf.sh = sh
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    view = "front0" if kc.FRONT0 else "turned"
    tmp0 = Path(os.environ.get("TEMP", "/tmp")) / f"swaggate-{view}"
    report, fails = {}, 0
    for name in a.sets.split(","):
        poses = ss.SETS[name]
        full = render(poses, tmp0 / "full", a.rig)
        alone = {p: render(poses, tmp0 / p, a.rig, hide_all_but=p) for p in PIECES}
        for i, pose in enumerate(poses):
            rec, marks = {}, np.zeros(full[i].shape[:2], bool)
            for p in PIECES:
                n, longest, m = edge_breaks(full[i], alone[p][i])
                rec[p] = dict(breaks=n, longest_px=longest)
                marks |= m
            ok = all(r["breaks"] == 0 for r in rec.values())
            rec["pass"] = ok
            report[f"{name}/{pose}"] = rec
            if not ok:
                fails += 1
                im = kf.on_bg(Image.fromarray(full[i].astype(np.uint8)))
                arr = np.asarray(im).copy()
                arr[ndimage.binary_dilation(marks, iterations=2)] = (255, 0, 255)
                Image.fromarray(arr).crop((250, 560, 840, 1000)).save(out / f"gate-{view}-{name}-{pose}.png")
    summary = dict(view=view, skin=a.skin, max_break_px=MAX_BREAK, poses=len(report), failed=fails, results=report)
    (out / f"gate-{view}.json").write_text(json.dumps(summary, indent=1))
    print(f"{a.skin} {view}: {len(report) - fails}/{len(report)} poses pass (breaks > {MAX_BREAK:g} px)")
    for k, r in report.items():
        if not r["pass"]:
            print("  FAIL", k, {p: r[p] for p in PIECES if r[p]["breaks"]})
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
