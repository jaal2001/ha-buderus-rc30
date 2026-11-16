"""Build a deterministic manual-install archive without configuration or tests."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "custom_components" / "buderus_rc30"
OUTPUT = ROOT / "dist" / "buderus_rc30.zip"
OUTPUT.parent.mkdir(exist_ok=True)

with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as archive:
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if path.suffix not in (".py", ".json", ".png", ".js"):
            continue
        info = ZipInfo(path.relative_to(ROOT).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(OUTPUT)
