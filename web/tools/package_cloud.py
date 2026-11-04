from pathlib import Path
import hashlib
import json
import os
import zipfile

root = Path(os.getenv('MARKET_BUILD_DIR', '../.cloud-build/kalshi')).resolve()
if not (root / 'index.js').is_file() or not (root / 'worker.mjs').is_file():
    raise SystemExit('Build the cloud server before packaging')
target = root.with_suffix('.zip')
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_symlink():
            raise ValueError('Deployment archives cannot contain links')
        if file.is_file():
            archive.write(file, file.relative_to(root).as_posix())
info = dict(path=str(target), bytes=target.stat().st_size,
            key='code/' + hashlib.sha256(target.read_bytes()).hexdigest() + '.zip')
(root.parent / 'package.json').write_text(json.dumps(info, indent=2), encoding='utf-8')
print(json.dumps(info))
