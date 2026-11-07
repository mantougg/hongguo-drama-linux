#!/usr/bin/env python3
"""Restore the pinned media tools from the project's latest release or the first-build bootstrap."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
from urllib.error import HTTPError
from urllib.request import urlopen

ARCHIVE_SHA = '901568b9c7f7918e6565c86c60f8c7b42ae17024b67026773cb81c28346ad694'
UPSTREAM_SHA = '80742938a95f9ecf9e0635192b417b7af61ddd53c4ab511898a11da5dad81667'
BOOTSTRAP_URL = 'https://github.com/yxt02/hongguo-drama-linux/releases/download/v1.74.6-linux/hongguo-drama-1.74.6-linux-x64.tar.gz'
BINARIES = {'ffmpeg': '00550c65fc35d8e21acae12c4262bdbf74df9b79fa996eb71c85a014571d8542',
            'ffprobe': 'effc9977f8dcb67e8f459822138b0663c44434aafaf4fef058b5c67dfb6dd8c4'}


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def release_asset(repository):
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('Invalid GitHub repository name')
    base = f'https://github.com/{repository}/releases'
    try:
        with urlopen(base + '/latest/download/SHA256SUMS.txt', timeout=30) as response:
            checksums = response.read(65_537)
    except HTTPError as error:
        if error.code == 404:
            return BOOTSTRAP_URL, ARCHIVE_SHA
        raise
    if len(checksums) > 65_536:
        raise ValueError('Release checksum file is too large')
    rows = re.findall(rb'^([0-9a-fA-F]{64})[ \t]+\*?(hongguo-drama-([0-9]+\.[0-9]+\.[0-9]+)-linux-x64\.tar\.gz)\r?$', checksums, re.MULTILINE)
    if len(rows) != 1:
        raise ValueError('Release checksum file must name exactly one Linux bundle')
    sha, filename, version = (part.decode('ascii') for part in rows[0])
    return f'{base}/download/v{version}-linux/{filename}', sha.lower()


def restore(archive, source, archive_sha):
    if digest(archive) != archive_sha:
        raise ValueError('Media source bundle checksum mismatch')
    dest = Path(__file__).resolve().parent.parent / 'build/ffmpeg/linux-x64'
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest) as directory, tarfile.open(archive, 'r:gz') as bundle:
        staging = Path(directory)
        for name, expected in BINARIES.items():
            member = bundle.getmember('hongguo-linux-x64/app/resources/bin/' + name)
            if not member.isfile() or member.size > 200_000_000:
                raise ValueError('Unexpected media entry')
            target = staging / name
            with bundle.extractfile(member) as stream, target.open('wb') as output:
                shutil.copyfileobj(stream, output)
            if digest(target) != expected:
                raise ValueError(name + ' checksum mismatch')
            target.chmod(0o755)
        manifest = staging / 'build-manifest.json'
        manifest.write_text(json.dumps({
            'source': source, 'recovered_bundle_sha256': archive_sha,
            'artifact_sha256': UPSTREAM_SHA, 'binaries': BINARIES,
        }, indent=2) + '\n')
        for name in (*BINARIES, manifest.name):
            os.replace(staging / name, dest / name)
    print('Recovered unchanged FFmpeg/FFprobe; bundle and both binaries verified')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, nargs='?', help='use a local copy of the verified bootstrap bundle')
    parser.add_argument('--repository', default='mantougg/hongguo-drama-linux')
    args = parser.parse_args()
    if args.archive:
        restore(args.archive, BOOTSTRAP_URL, ARCHIVE_SHA)
        return
    source, archive_sha = release_asset(args.repository)
    with tempfile.TemporaryDirectory(prefix='hongguo-media-') as directory:
        archive = Path(directory) / 'media.tar.gz'
        subprocess.run(['curl', '-fL', '--retry', '3', '--max-time', '300', '--max-filesize', '629145600',
                        '-o', str(archive), source], check=True)
        restore(archive, source, archive_sha)


if __name__ == '__main__':
    main()
