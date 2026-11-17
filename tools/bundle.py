#!/usr/bin/env python3
"""Bundle the console's ES modules and data into self-contained pages (no Node.js needed).

Each module is wrapped in its own function scope; `import {..} from "./x.js"` lines become
destructuring of earlier modules. Export names are read from the module source by a small
scanner (declarations and `export { .. }` lists), so the bundle needs only Python.
SPDX-License-Identifier: GPL-3.0-only
"""
import base64, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = "1.4.0"


def _declarators(src: str, i: int) -> list:
    """Split `a = .., b = ..;` at depth-0 commas, honouring strings, template literals and comments."""
    decls, start, stack = [], i, [['code', 0]]
    while i < len(src):
        c, top = src[i], stack[-1]
        if top[0] == 'code':
            if c in '"\'': stack.append([c, 0])
            elif c == '`': stack.append(['`', 0])
            elif c == '/' and src[i + 1:i + 2] == '/': j = src.find('\n', i); i = len(src) if j < 0 else j; continue
            elif c == '/' and src[i + 1:i + 2] == '*': i = src.find('*/', i + 2) + 2; continue
            elif c in '([{': top[1] += 1
            elif c in ')]}':
                if top[1] == 0 and len(stack) > 1: stack.pop()
                else: top[1] -= 1
            elif len(stack) == 1 and top[1] == 0 and c == ',': decls.append(src[start:i]); start = i + 1
            elif len(stack) == 1 and top[1] == 0 and c == ';': decls.append(src[start:i]); return decls
        elif top[0] in '"\'':
            if c == '\\': i += 2; continue
            if c == top[0]: stack.pop()
        else:
            if c == '\\': i += 2; continue
            if c == '`': stack.pop()
            elif c == '$' and src[i + 1:i + 2] == '{': stack.append(['code', 0]); i += 2; continue
        i += 1
    decls.append(src[start:])
    return decls


def exports_of(src: str) -> list:
    names = []
    for m in re.finditer(r'^export\s+(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)', src, re.M): names.append((m.start(), m.group(1)))
    for m in re.finditer(r'^export\s+class\s+([A-Za-z_$][\w$]*)', src, re.M): names.append((m.start(), m.group(1)))
    for m in re.finditer(r'^export\s*\{([^}]*)\};?', src, re.M):
        for part in m.group(1).split(','):
            part = part.strip()
            if part: names.append((m.start(), part.split(' as ')[-1].strip()))
    for m in re.finditer(r'^export\s+(?:const|let|var)\s+', src, re.M):
        for d in _declarators(src, m.end()):
            mm = re.match(r'\s*([A-Za-z_$][\w$]*)', d)
            if mm: names.append((m.start(), mm.group(1)))
    # sorted by code point, the order of a module namespace object (so the bundle matches Node's)
    return sorted({n for _, n in names})


def bundle(paths, expose):
    out, names = [], {}
    for path in paths:
        key = pathlib.Path(path).stem.replace('-', '_')
        src = (ROOT / path).read_text(encoding='utf-8')
        imports = re.findall(r'^import \{([^}]*)\} from "\./([A-Za-z0-9_-]+)\.js";\n', src, flags=re.M)
        exported = exports_of(src)
        if len(re.findall(r'^import ', src, flags=re.M)) != len(imports): sys.exit(f'bundle: {path} has an import the bundler does not understand')
        for _, mod in imports:
            if mod.replace('-', '_') not in names: sys.exit(f'bundle: {path} imports ./{mod}.js, which is not bundled before it')
        src = re.sub(r'^import [^\n]*\n', '', src, flags=re.M)
        src = re.sub(r'^export \{[^}]*\};\n', '', src, flags=re.M)
        src = re.sub(r'^export ', '', src, flags=re.M)
        rename = lambda names: re.sub(r'\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)', r'\1: \2', names)  # import { a as b } -> const { a: b }
        head = ''.join(f"const {{ {rename(n)} }} = __mod_{mod.replace('-', '_')};\n" for n, mod in imports)
        out.append(f"const __mod_{key} = (() => {{\n{head}{src}\nreturn {{ {', '.join(exported)} }};\n}})();")
        names[key] = exported
    seen = {}
    for k, v in names.items():
        if k not in expose: continue
        for n in v:
            if n in seen: sys.exit(f'bundle: {n} is exported by both {seen[n]} and {k}; exposed names must be unique')
            seen[n] = k
    glob = ''.join(f"const {{ {', '.join(v)} }} = __mod_{k};\n" for k, v in names.items() if k in expose)
    return '\n'.join(out) + '\n' + glob


def b64(path):
    return base64.b64encode((ROOT / path).read_bytes()).decode()


def wrap(page):
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' + page + '\n</body>\n</html>\n')


def js_string(text):
    s = json.dumps(text, ensure_ascii=True)
    return s.replace('</', '<\\/')


def main():
    xpu, xpu_mt = b64('web/xpu.wasm'), b64('web/xpu-mt.wasm')
    templates = (ROOT / 'web/r-templates.json').read_text(encoding='utf-8')
    valley_templates = (ROOT / 'web/valley-templates.json').read_text(encoding='utf-8')
    css = (ROOT / 'src/ui.css').read_text(encoding='utf-8')
    cells = (ROOT / 'data/simmy/cells.json').read_text(encoding='ascii')
    workload = (ROOT / 'data/simmy/authority_workload_rails.json').read_text(encoding='ascii')
    console_mods = ['src/lcufa.js', 'src/russl.js', 'src/schemas.js', 'src/schema.js', 'src/engines.js', 'src/russ.js']
    common = {'%%VERSION%%': VERSION, '%%CSS%%': css, '%%TEMPLATES%%': templates, '%%VALLEY_TEMPLATES%%': valley_templates,
              '%%XPU_B64%%': xpu, '%%XPU_MT_B64%%': xpu_mt, '%%SIMMY_CELLS%%': js_string(cells), '%%SIMMY_WORKLOAD%%': js_string(workload)}
    pages = [
        ('src/page.html', 'index.html', 'plume-xpu-console.html', console_mods, ('lcufa', 'engines', 'russ')),
        ('src/show.html', 'show.html', 'plume-xpu-live.html', console_mods, ('lcufa', 'engines', 'russ')),
        ('src/simmy.html', 'simmy.html', 'plume-simmy-replay.html', ['src/simmy.js'], ('simmy',)),
        ('src/valley.html', 'valley.html', 'plume-deer-valley.html',
         console_mods + ['src/simmy.js', 'src/valley.js', 'src/valleymap.js', 'src/byte20.js', 'src/gl.js', 'src/valley3d_detail.js', 'src/valley3d_atmos.js', 'src/valley3d_shaders.js', 'src/valley3d_meshes.js', 'src/valley3d_forms.js', 'src/valley3d_flora.js', 'src/valley3d_morph.js', 'src/valley3d_birds.js', 'src/valley3d_eye.js', 'src/valley3d_strands.js', 'src/valley3d_perf.js', 'src/valley3d.js'],
         ('lcufa', 'engines', 'russ', 'simmy', 'valley', 'valleymap', 'byte20', 'valley3d')),
        ('src/verify.html', 'verify.html', 'plume-verify-r.html', ['src/lcufa.js', 'src/russl.js', 'src/schemas.js', 'src/schema.js', 'src/russ.js'], ('russ',)),
    ]
    for src, web, dist, mods, expose in pages:
        if not (ROOT / src).exists():
            print(f'skipped {src} (not present)'); continue
        page = (ROOT / src).read_text(encoding='utf-8')
        page = page.replace('%%MODULES%%', bundle(mods, expose))
        for k, v in common.items(): page = page.replace(k, v)
        if '%%' in re.sub(r'%%[^%\s]*\b', '', page) and re.search(r'%%[A-Z_]+%%', page):
            sys.exit(f'{src}: unreplaced placeholder {re.search(r"%%[A-Z_]+%%", page).group(0)}')
        # dist/ holds the same pages under longer names: point their links at those names
        dist_page = page
        for _, w, d, _, _ in pages: dist_page = dist_page.replace(f'href="{w}"', f'href="{d}"')
        (ROOT / 'dist' / dist).write_text(dist_page, encoding='utf-8')
        (ROOT / 'web' / web).write_text(wrap(page), encoding='utf-8')
        print(f'built web/{web} and dist/{dist}, {len(page) // 1024} KB')


if __name__ == '__main__':
    main()
