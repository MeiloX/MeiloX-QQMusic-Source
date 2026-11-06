#!/usr/bin/env python3
"""Build the source-only QQ adapter package without including credentials or captures."""
from pathlib import Path
import subprocess
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent
subprocess.run(["node", "build.mjs"], cwd=root, check=True)
target = root / "qq-music.meisource"
with ZipFile(target, "w", compression=ZIP_DEFLATED) as package:
    for name in ("manifest.json", "index.js", "LICENSE", "NOTICE"):
        limit = 256 * 1024 if name == "index.js" else 64 * 1024
        if (root / name).stat().st_size > limit:
            raise ValueError("Package text exceeds the source SDK limit")
        info = ZipInfo(name, (2026, 11, 6, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        package.writestr(info, (root / name).read_bytes())
print(target)
