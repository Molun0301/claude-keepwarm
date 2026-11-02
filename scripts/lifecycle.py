"""供各发布仓库复制使用的安装记录与文件生命周期工具。"""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile


def read_json(path, default=None):
    if not path.exists():
        return {} if default is None else default
    return json.loads(path.read_text(encoding='utf-8'))


def atomic(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise ValueError(f'拒绝覆盖符号链接：{path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.plugin-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(content)
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save_json(path, value):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Installation:
    def __init__(self, directory, name, version):
        self.directory = Path(directory).expanduser().absolute()
        self.receipt = self.directory / ('.' + name + '-install.json')
        self.state = read_json(self.receipt, {'name': name, 'files': {}, 'settings': {}})
        if self.state.get('name') != name:
            raise ValueError('安装记录不属于此插件')
        self.state['version'] = version

    def save(self):
        save_json(self.receipt, self.state)

    def install(self, files, replace=False):
        # 先核对全部文件，再写入；重复升级不能悄悄覆盖用户修改。
        for relative, content in files.items():
            target = self.directory / relative
            if target.is_symlink():
                raise ValueError(f'目标是符号链接，请先迁移：{target}')
            if target.exists():
                previous = self.state['files'].get(relative)
                old = target.read_bytes()
                owned = previous and digest(old) == previous['hash']
                if not owned and old != content and not replace:
                    raise ValueError(f'文件已存在或已被修改：{target}；明确替换请加 --replace')
        for relative, content in files.items():
            target = self.directory / relative
            previous = self.state['files'].get(relative)
            if not previous:
                previous = {'original': base64.b64encode(target.read_bytes()).decode() if target.exists() else None,
                            'mode': target.stat().st_mode & 0o777 if target.exists() else 0o644}
            previous['hash'] = digest(content)
            # 先保存恢复信息，即使后续写入失败也可再次执行或卸载。
            self.state['files'][relative] = previous
            self.save()
            atomic(target, content, 0o644)

    def set_field(self, settings_file, key, value, replace=False):
        current = read_json(settings_file)
        record = self.state['settings'].get(key)
        if key in current and current[key] != value and not replace and (not record or current[key] != record['installed']):
            raise ValueError(f'现有 {key} 由其他配置管理；明确替换请加 --replace')
        if not record:
            record = {'exists': key in current, 'original': current.get(key)}
        record['installed'] = value
        self.state['settings'][key] = record
        self.save()
        current[key] = value
        save_json(settings_file, current)

    def uninstall(self, settings_file=None):
        kept = []
        if settings_file and settings_file.exists():
            current = read_json(settings_file)
            for key, record in self.state['settings'].items():
                if current.get(key) == record['installed']:
                    if record['exists']:
                        current[key] = record['original']
                    else:
                        current.pop(key, None)
                elif key in current:
                    kept.append(f'已更改设置 {key}')
            save_json(settings_file, current)
        for relative, record in self.state['files'].items():
            target = self.directory / relative
            if not target.exists() and not target.is_symlink():
                continue
            if target.is_symlink() or digest(target.read_bytes()) != record['hash']:
                kept.append(str(target))
                continue
            if record['original'] is not None:
                atomic(target, base64.b64decode(record['original']), record['mode'])
            else:
                target.unlink()
                parent = target.parent
                while parent != self.directory:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
        self.receipt.unlink(missing_ok=True)
        for item in kept:
            print('保留用户修改：' + item)
