#!/usr/bin/env python3
"""从已提交的 Git 版本构建发布归档和校验摘要。"""
import hashlib
from pathlib import Path
import subprocess
import zipfile
ROOT = Path(__file__).resolve().parents[1]
NAME = 'claude-keepwarm'
version = (ROOT / 'VERSION').read_text().strip()
if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT).strip():
    raise SystemExit('存在未提交修改，请提交后打包')
dist = ROOT / 'dist';dist.mkdir(exist_ok=True)
archive = dist / f'{NAME}-{version}.zip'
subprocess.run(['git', 'archive', '--format=zip', f'--prefix={NAME}/', '-o', str(archive), 'HEAD'], cwd=ROOT, check=True)
with zipfile.ZipFile(archive) as z:
    names = z.namelist()
    assert not any('/docs/开发文档/' in n or '/page/snapshot.js' in n or n.endswith('/.env') for n in names)
    assert f'{NAME}/README.md' in names
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(dist / 'SHA256SUMS').write_text(checksum + '  ' + archive.name + '\n')
print(archive)
