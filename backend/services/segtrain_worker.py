#!/usr/bin/env python3
"""
Wrapper script that calls ketos segtrain with Lightning's save_last=True.

WHY THIS EXISTS
--------------
ketos segtrain monitors val_mean_iu for checkpoint saving. With medieval
manuscript training data, val_mean_iu plateaus almost immediately (e.g.
0.3333 from epoch 2 onward) while val_bl_f1 — the metric that actually
measures baseline detection quality — keeps improving.

Lightning's ModelCheckpoint with save_top_k=10 keeps the 10 checkpoints
with the BEST score. When all 80 epochs tie at 0.3333, it keeps epochs 2–11
(the first 10) and silently deletes 12–79. The final model with good bl_f1
is therefore never saved by default.

THE FIX
-------
Patch ModelCheckpoint.__init__ to force save_last=True before any ketos
code runs. This makes Lightning always write a 'last.ckpt' alongside the
top-K checkpoints, regardless of whether the score improved. After training
the caller converts last.ckpt to weights.

The patch uses setdefault so it never overrides an explicit save_last=False
if ketos ever decides to set one.

USAGE
-----
Called by trainer.start_segtrain() instead of 'ketos segtrain' directly:

    python segtrain_worker.py --workers 0 segtrain -f alto -o ... files...

The script reconstructs the ketos CLI from sys.argv and delegates to it.
"""

import sys

# ── Patch ModelCheckpoint before any kraken/ketos import touches Lightning ──
import lightning.pytorch.callbacks.model_checkpoint as _mc

_orig_mc_init = _mc.ModelCheckpoint.__init__


def _save_last_init(self, *args, **kwargs):
    # Force save_last=True so the final epoch is always preserved.
    # setdefault means we never clobber an explicit save_last=False.
    kwargs.setdefault("save_last", True)
    _orig_mc_init(self, *args, **kwargs)


_mc.ModelCheckpoint.__init__ = _save_last_init

# ── Delegate to the ketos CLI ───────────────────────────────────────────────
# sys.argv arrives as: [this_script, --workers, 0, segtrain, ...]
# ketos CLI expects:   [ketos,       --workers, 0, segtrain, ...]
sys.argv = ["ketos"] + sys.argv[1:]

from kraken.ketos import cli  # noqa: E402 — must import after patch

sys.exit(cli(standalone_mode=True))
