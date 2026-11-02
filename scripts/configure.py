#!/usr/bin/env python3
"""合并功能钩子设置；卸载时只恢复仍由本助手管理的字段。"""
import argparse
import os
from pathlib import Path
from lifecycle import Installation, read_json, save_json
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('action', choices=['enable', 'restore'])
p.add_argument('--config-dir', type=Path, default=Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude')))
a = p.parse_args()
try:
    directory = a.config_dir.expanduser().absolute()
    state = Installation(directory, 'keepwarm-function-hooks', '0.9.3')
    file = directory / 'settings.json'
    data = read_json(file)
    env = data.setdefault('env', {})
    key = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'
    if a.action == 'enable':
        if 'env_original' not in state.state:
            state.state['env_original'] = {'exists': key in env, 'value': env.get(key)}
        state.save()
        env[key] = '1'
    else:
        if not state.receipt.exists():
            p.exit(0, '没有本助手的安装记录，无需恢复。\n')
        original = state.state['env_original']
        if env.get(key) == '1':
            if original['exists']:
                env[key] = original['value']
            else:
                env.pop(key, None)
        state.receipt.unlink()
    save_json(file, data)
    print('设置已更新；新会话或 /reload-plugins 后生效。')
except (ValueError, OSError) as exc:
    p.exit(1, str(exc) + '\n')
