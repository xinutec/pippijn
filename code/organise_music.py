import glob
import os
import subprocess
import sys

from typing import List
from typing import Tuple


UNKNOWN_ARTIST = "Unknown Artist"
UNKNOWN_ALBUM = "Unknown Album"


def tag(line: str) -> str:
    return line[:line.index(" ")]


def is_tag(line: str) -> bool:
    return " " in line and tag(line) in (
            "TT2", "TP1", "TAL", "TRK", "TPA", "TYE", "TCO",
            "TIT2", "TPE1", "TALB", "TYER", "TRCK", "TPOS", "TCON")


def organise_mp3(oldname: str) -> int:
    if os.path.exists(oldname[:-4] + ".flac") or os.path.exists(oldname[:-4] + ".ogg"):
        print(f"deleting {oldname}")
        os.remove(oldname)
        return 0

    stdout = subprocess.run(["id3v2", "-l", oldname], capture_output=True, check=True).stdout
    try:
        out = stdout.decode("utf-8")
    except UnicodeError as e:
        out = stdout.decode("iso8859-15")
    tags = {
        tag(line): line.split(": ")[1].replace("/", "-")
        for line in out.split("\n")
        if is_tag(line)
    }
    try:
        path = os.path.join(
                tags.get("TPE1") or tags.get("TP1") or UNKNOWN_ARTIST,
                tags.get("TALB") or tags.get("TAL") or UNKNOWN_ALBUM)
        os.makedirs(path, exist_ok=True)
        newname = os.path.join(path,
                tags.get("TIT2") or tags.get("TT2") or os.path.basename(oldname[:-4])) + ".mp3"
        if oldname == newname:
            return 0
        print(f"{oldname} -> {newname}")
        os.rename(oldname, newname)
        return 1
    except KeyError as e:
        print(f"{oldname}: missing field {e}")
        return 0


def organise_vorbis(command: List[str], oldname: str, suffix: str) -> int:
    def ucfirst(k: str, v: str) -> Tuple[str, str]:
        return (k.upper(), v)
    try:
        out = subprocess.run(command + [oldname], capture_output=True, check=True).stdout.decode("utf-8")
    except UnicodeError as e:
        print(f"{oldname}: {e}")
        return 0
    tags = dict(
        ucfirst(*line.split("=", 1))
        for line in out.replace("/", "-").split("\n")
        if "=" in line
    )
    try:
        path = os.path.join(tags["ARTIST"] or UNKNOWN_ARTIST,
                            tags["ALBUM"] or UNKNOWN_ALBUM)
        os.makedirs(path, exist_ok=True)
        newname = os.path.join(path, tags["TITLE"]) + suffix
        if oldname == newname:
            return 0
        print(f"{oldname} -> {newname}")
        os.rename(oldname, newname)
        return 1
    except KeyError as e:
        print(f"{oldname}: missing field {e}")
        return 0


def process(oldname: str) -> int:
    if oldname.endswith(".flac"):
        return organise_vorbis(["metaflac", "--export-tags-to=/dev/stdout"], oldname, ".flac")
    elif oldname.endswith(".ogg"):
        return organise_vorbis(["vorbiscomment"], oldname, ".ogg")
    elif oldname.endswith(".mp3"):
        return organise_mp3(oldname)
    else:
        return 0


PATTERNS = (
    "**/*.flac",
    "**/*.mp3",
    "**/*.ogg",
)

if __name__ == '__main__':
    patterns = sys.argv[1:] if len(sys.argv) > 1 else PATTERNS
    for pattern in patterns:
        files = glob.glob(pattern, recursive=True)
        print(f"Processing {pattern}: {len(files)} files")
        success = sum(map(process, files))
        print(f"{success} successful")
