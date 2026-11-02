#!/usr/bin/env python3
"""发布前执行版本、隐私、语法和行为检查。"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'claude-keepwarm'
os.chdir(ROOT)
version = (ROOT / 'VERSION').read_text().strip()
assert re.fullmatch(r'\d+\.\d+\.\d+', version), '版本号须为 X.Y.Z'
manifest = {'visualize-logic-review': 'plugin.json', 'claude-keepwarm': 'plugins/keepwarm/.claude-plugin/plugin.json'}.get(PROJECT, 'package.json')
assert json.loads((ROOT / manifest).read_text())['version'] == version, '版本不一致'
if PROJECT == 'visualize-logic-review':
    for file in ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']:
        assert json.loads((ROOT / file).read_text())['version'] == version
pattern = re.compile(r'(?:gh[pousr]_|github_pat_|sk-ant-|sk-proj-)[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|' + '/home/' + 'ml/')
files = [f for f in ROOT.rglob('*') if f.is_file() and not any(x in f.relative_to(ROOT).parts for x in ['.git', '__pycache__', 'node_modules', 'work', 'dist', '开发文档']) and f.relative_to(ROOT).as_posix() != 'page/snapshot.js']
for f in files:
    if f.suffix in ['.py', '.js', '.cjs', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml', '.sh', '.html']:
        text = f.read_text()
        assert not pattern.search(text), f'存在疑似秘密或个人绝对路径：{f.relative_to(ROOT)}'
        if f.suffix == '.py':
            compile(text, str(f), 'exec')
        elif f.suffix == '.json':
            json.loads(text)
        elif f.suffix in ['.js', '.cjs', '.mjs']:
            subprocess.run(['node', '--check', str(f)], check=True)
with tempfile.TemporaryDirectory(prefix='plugin-check-') as temp:
    env = {**os.environ, 'HOME': temp, 'XDG_CONFIG_HOME': temp + '/.config', 'XDG_CACHE_HOME': temp + '/.cache'}
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], env=env, check=True)
    cases = sorted([str(f) for f in (ROOT / 'tests').glob('*.test.cjs')] + [str(f) for f in (ROOT / 'tests').glob('*.test.mjs')])
    if cases:
        subprocess.run(['node', '--test', *cases], env=env, check=True)
    if PROJECT == 'visualize-logic-review':
        skill = ROOT / 'skills/visualize-logic-review'
        for example in (skill / 'examples').glob('*.json'):
            target = Path(temp) / example.stem
            subprocess.run([sys.executable, '-I', str(skill / 'scripts/render_review.py'), str(example), '--out', str(target)], check=True)
            assert (target / 'index.html').exists() and list(target.glob('*.svg'))
print('发布检查通过：' + PROJECT + ' ' + version)
