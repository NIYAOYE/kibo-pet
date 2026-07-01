#!/usr/bin/env python3
"""Package a validated atlas as a local desktop pet package (pet.json + sheet)."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

from PIL import Image

from pet_layout import ATLAS_SIZE, animations_manifest, sheet_manifest


def default_package_root() -> Path:
    """Default packages land in <cwd>/pets so running from the project root
    drops the pet straight into the app's pets/ folder."""
    return (Path.cwd() / "pets").resolve()


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


def validate_spritesheet(path: Path) -> str:
    with Image.open(path) as image:
        if image.size != ATLAS_SIZE:
            raise SystemExit(
                f"expected {ATLAS_SIZE[0]}x{ATLAS_SIZE[1]}, got {image.width}x{image.height}"
            )
        if image.format not in {"PNG", "WEBP"}:
            raise SystemExit(f"expected PNG or WebP, got {image.format}")
        return str(image.format)


def write_webp_spritesheet(source: Path, target: Path, source_format: str) -> None:
    if source_format == "WEBP":
        shutil.copy2(source, target)
        return
    with Image.open(source) as image:
        target.parent.mkdir(parents=True, exist_ok=True)
        image.convert("RGBA").save(
            target,
            format="WEBP",
            lossless=True,
            quality=100,
            method=6,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pet-name", default="")
    parser.add_argument("--display-name", default="")
    parser.add_argument("--description", required=True)
    parser.add_argument("--spritesheet", required=True)
    parser.add_argument(
        "--package-root",
        default=str(default_package_root()),
        help="Parent folder that holds pet packages. Defaults to <cwd>/pets.",
    )
    parser.add_argument(
        "--output-dir",
        help="Exact pet package directory. Defaults to <package-root>/<pet-id>.",
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    raw_pet_name = (args.pet_name or args.display_name).strip()
    if not raw_pet_name:
        raise SystemExit("pet name is required")
    pet_id = slugify(raw_pet_name)
    if not pet_id:
        raise SystemExit("pet name must contain at least one letter or digit")
    display_name = (args.display_name or raw_pet_name).strip()

    source = Path(args.spritesheet).expanduser().resolve()
    source_format = validate_spritesheet(source)
    target_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else Path(args.package_root).expanduser().resolve() / pet_id
    )
    target_dir.mkdir(parents=True, exist_ok=True)

    target_sheet = target_dir / "spritesheet.webp"
    manifest_path = target_dir / "pet.json"
    if not args.force and (target_sheet.exists() or manifest_path.exists()):
        raise SystemExit(f"{target_dir} already contains pet files; pass --force to overwrite")

    write_webp_spritesheet(source, target_sheet, source_format)
    manifest = {
        "id": pet_id,
        "displayName": display_name,
        "description": args.description,
        "spritesheetPath": target_sheet.name,
        "sheet": sheet_manifest(),
        "animations": animations_manifest(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {"ok": True, "pet_dir": str(target_dir), "manifest": str(manifest_path)}, indent=2
        )
    )


if __name__ == "__main__":
    main()
