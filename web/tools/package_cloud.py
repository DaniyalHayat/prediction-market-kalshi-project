from pathlib import Path
import hashlib
import json
import os
import zipfile

root = Path(os.getenv('MARKET_BUILD_DIR', '../.cloud-build/predictir')).resolve()
if not (root / 'index.js').is_file() or not (root / 'worker.mjs').is_file():
    raise SystemExit('Build the cloud server before packaging')
target = root.with_suffix('.zip')
public_source = Path(__file__).resolve().parent.parent / 'public'
public_files = [Path('public') / file.relative_to(public_source)
                for file in public_source.rglob('*') if file.is_file()]
package_files = {Path(name) for name in ('index.js', 'worker.mjs', 'package.json', 'public/risk-client.js')}
package_files.update(public_files)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(package_files):
        file = root / path
        if any(part.is_symlink() for part in (file, *file.parents) if part.is_relative_to(root)):
            raise ValueError('Deployment archives cannot contain links')
        archive.write(file, path.as_posix())
info = dict(path=str(target), bytes=target.stat().st_size,
            key='code/' + hashlib.sha256(target.read_bytes()).hexdigest() + '.zip')
(root.parent / 'package.json').write_text(json.dumps(info, indent=2), encoding='utf-8')
print(json.dumps(info))
