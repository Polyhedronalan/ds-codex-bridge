#!/usr/bin/env python3
"""Build a repeatable, explicit-allowlist GitHub source ZIP using only stdlib."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = """
.gitattributes
.gitignore
.github/workflows/ci.yml
package.json
README.md
SECURITY.md
COMPATIBILITY.md
config.example.json
bridge.mjs
compat.mjs
config.mjs
deepseek-history.mjs
gpt-quota-gate.mjs
log-rotation.mjs
logger.mjs
security.mjs
tool-policy.mjs
upstreams.mjs
runtime-lib.ps1
ensure-bridge.ps1
start-production.ps1
stop-production.ps1
BridgeHealth.cmd
BridgeRepair.cmd
tools/protect-secret.ps1
tools/bridge-health.ps1
tools/repair-policy.ps1
tools/test-transport.mjs
tools/Initialize-Bridge.ps1
tools/package-release.py
tests/bridge.test.mjs
tests/deepseek-history.test.mjs
tests/log-rotation.test.mjs
tests/tool-policy.test.mjs
tests/quota-gate.test.mjs
tests/health-log.test.ps1
tests/repair-policy.test.ps1
tests/transport-probe.test.mjs
tests/fixtures/tool-policy-legacy-guard.json
tests/fixtures/gpt-after-deepseek.json
examples/codex.config.example.toml
examples/gpt-quota-gate.example.json
docs/RELEASE-NOTES.md
docs/source-provenance.json
""".split()

# Never print a matched value: a failure identifies only the file and rule.
PATTERNS = {
    'API key': r'\bsk-[A-Za-z0-9_-]{20,}',
    'GitHub token': r'\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}',
    'JWT': r'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}',
    'DPAPI blob': r'AQAAANCMnd8[A-Za-z0-9+/=]{40,}',
    'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'personal absolute path': r'[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b)[^\s\"\'<>]+',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate():
    errors, content = [], {}
    for name in sorted(FILES):
        file = ROOT / name
        if file.is_symlink() or any(p.is_symlink() for p in file.parents if p != ROOT.parent):
            errors.append(f'{name}: symlink not allowed')
            continue
        if not file.is_file():
            errors.append(f'{name}: missing file')
            continue
        data = file.read_bytes()
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            errors.append(f'{name}: expected UTF-8 source')
            continue
        for rule, pattern in PATTERNS.items():
            if re.search(pattern, text):
                errors.append(f'{name}: possible {rule}')
        content[name] = data
    provenance = json.loads((ROOT / 'docs/source-provenance.json').read_text(encoding='utf-8'))
    for entry in provenance['core_files']:
        if sha(content.get(entry['path'], b'')) != entry['sha256']:
            errors.append(f"{entry['path']}: maintained source hash mismatch")
    if len(FILES) != len(set(FILES)):
        errors.append('duplicate allowlist entries')
    if errors:
        raise SystemExit('Release check failed:\n' + '\n'.join(errors))
    return content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='validate without writing output')
    args = parser.parse_args()
    content = validate()
    print(f'PASS: {len(content)} allowlisted files; core hashes and sensitive-content patterns checked')
    if args.check:
        return
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise SystemExit('invalid package version')
    prefix = 'ds-codex-bridge'
    manifest = ''.join(f'{sha(data)}  {name}\n' for name, data in sorted(content.items()))
    content['SHA256SUMS'] = manifest.encode('utf-8')
    dist = ROOT / 'dist'
    # A local symlink must not redirect release output outside the project.
    if dist.is_symlink():
        raise SystemExit('dist symlink not allowed')
    dist.mkdir(exist_ok=True)
    output = dist / f'{prefix}-{version}.zip'
    if output.is_symlink() or output.with_suffix('.zip.sha256').is_symlink():
        raise SystemExit('output symlink not allowed')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(f'{prefix}/{name}', (2026, 10, 24, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=9)
    digest = sha(output.read_bytes())
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n', encoding='ascii')
    print(f'Built {output.name}: {output.stat().st_size} bytes; SHA256 {digest}')


if __name__ == '__main__':
    main()
