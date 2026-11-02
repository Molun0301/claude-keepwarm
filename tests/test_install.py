"""用隔离主目录验证安装、升级冲突、用户配置保留及卸载恢复。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'claude-keepwarm'


class InstallTests(unittest.TestCase):
    def test_lifecycle(self):
        with tempfile.TemporaryDirectory(prefix='plugin-install-') as temp:
            home = Path(temp)
            env = {**os.environ, 'HOME': temp, 'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_DATA_HOME': str(home / '.local/share'), 'XDG_CACHE_HOME': str(home / '.cache')}
            def run(*args, ok=True):
                result = subprocess.run([sys.executable, *args], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
                return result
            if PROJECT == 'visualize-logic-review':
                args = ['--home', temp, '--target', 'both']
                run('scripts/install.py', 'install', *args)
                target = home / '.agents/skills/visualize-logic-review/SKILL.md'
                self.assertTrue(target.exists())
                run('scripts/install.py', 'install', *args)
                target.write_text('用户自己修改的技能')
                run('scripts/install.py', 'install', *args, ok=False)
                run('scripts/install.py', 'uninstall', *args)
                self.assertEqual(target.read_text(), '用户自己修改的技能')
                self.assertFalse((home / '.claude/skills/visualize-logic-review/SKILL.md').exists())
            elif PROJECT == 'claude-statusline':
                directory = home / '含 空格的配置'
                directory.mkdir()
                file = directory / 'settings.json'
                original = {'model': 'custom', 'statusLine': {'type': 'command', 'command': 'old-command'}, 'env': {'PRIVATE_VALUE': '仅测试占位'}}
                file.write_text(json.dumps(original))
                args = ['--config-dir', str(directory)]
                run('scripts/install.py', 'install', *args, ok=False)
                self.assertFalse((directory / 'local-statusline.js').exists())
                run('scripts/install.py', 'install', *args, '--replace')
                data = json.loads(file.read_text());self.assertEqual(data['env'], original['env'])
                command = data['statusLine']['command']
                rendered = subprocess.run(command, shell=True, input='{}', text=True, env=env, capture_output=True)
                self.assertEqual(rendered.returncode, 0, rendered.stderr)
                self.assertIn('账户待确认', rendered.stdout)
                data['addedLater'] = True;file.write_text(json.dumps(data))
                run('scripts/install.py', 'install', *args)
                run('scripts/install.py', 'uninstall', *args)
                self.assertEqual(json.loads(file.read_text()), {**original, 'addedLater': True})
                self.assertFalse((directory / 'local-statusline.js').exists())
                tabby = home / 'tabby'
                run('scripts/tabby.py', 'install', '--tabby-config', str(tabby))
                self.assertTrue((tabby / 'plugins/local/tabby-local-path-links/index.js').exists())
                run('scripts/tabby.py', 'uninstall', '--tabby-config', str(tabby))
                self.assertFalse((tabby / 'plugins/local/tabby-local-path-links/index.js').exists())
            elif PROJECT == 'claude-keepwarm':
                directory = home / '.claude';directory.mkdir()
                file = directory / 'settings.json'
                original = {'env': {'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '0', 'KEEP': 'yes'}, 'model': 'chosen'}
                file.write_text(json.dumps(original))
                args = ['--config-dir', str(directory)]
                run('scripts/configure.py', 'enable', *args)
                run('scripts/configure.py', 'enable', *args)
                data = json.loads(file.read_text());self.assertEqual(data['env']['KEEP'], 'yes')
                data['env']['LATER'] = 'preserved';file.write_text(json.dumps(data))
                run('scripts/configure.py', 'restore', *args)
                original['env']['LATER'] = 'preserved'
                self.assertEqual(json.loads(file.read_text()), original)
            else:
                destination = home / 'magpie-plugin'
                args = ['--destination', str(destination), '--no-service', '--no-register']
                run('scripts/install.py', 'install', *args)
                snapshot = destination / 'page/snapshot.js'
                self.assertTrue(snapshot.exists())
                snapshot.write_text('window.quotaSnapshot = {cards:[], custom:true};')
                run('scripts/install.py', 'install', *args)
                self.assertIn('custom:true', snapshot.read_text())
                self.assertTrue((destination / 'collect.py').exists())
                run('scripts/install.py', 'uninstall', *args)
                self.assertTrue(snapshot.exists())
                self.assertFalse((destination / 'collect.py').exists())


if __name__ == '__main__':
    unittest.main()
