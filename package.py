#!/usr/bin/env python3
"""Build the source-only QQ adapter package without including credentials or captures."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent
target = root / "qq-music.meisource"
with ZipFile(target, "w", compression=ZIP_DEFLATED) as package:
    for name in ("manifest.json", "index.js"):
        info = ZipInfo(name, (2026, 11, 6, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        package.writestr(info, (root / name).read_bytes())
print(target)
