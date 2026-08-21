#!/usr/bin/env python3
"""Config helper for the bundled session skills.

Reads the shared config the dashboard app writes:
  ~/.config/ai-agents-orchestrator/config.json
so the skills and the app agree on categories, note locations, and Obsidian vaults.

Root model (v2). A category lives under a named **root** (`{name,path}` in
`roots`); the category's `root` field names which one, so the SAME category name
can exist under several roots — (root, name) is the identity. **v1** configs
(`workRoot`/`personalRoot` + a category `scope` of work|personal) are still
understood: roots migrate to `Work` + `Perso` and `scope` → root. This mirrors the
Rust `derive()` — aoconfig reads the RAW config.json, it never sees derive()'s
output, so it must do its own v1/v2 handling.

Subcommands:
  categories        → newline-separated list of category names
  roots             → newline-separated list of root names
  rootpath <ROOT>   → absolute path of a named root, or '' if unknown
  root     <CAT>    → the root name a category lives under
  scope    <CAT>    → 'work' | 'personal' (default 'work'; inferred from root if absent)
  base     <CAT> [<ROOT>] → absolute base dir for a category (= <root path>/<CAT>);
                      optional <ROOT> disambiguates a category present under several roots
  dir      <CAT> <SLUG> [<ROOT>] → absolute workspace dir = base/<SLUG>
  vault    <CAT>    → Obsidian vault path for the category's scope, or '' if
                      Obsidian is disabled / no vault set for that scope
  find     <SLUG>   → newline-separated notes.md paths matching <SLUG> across all
                      (root, category) bases (for /restart-session, /close-session, /archive-session lookups)
"""
import json
import os
import sys

HOME = os.path.expanduser('~')
CONFIG = os.path.join(HOME, '.config', 'ai-agents-orchestrator', 'config.json')
DEFAULT_CATEGORIES = ['FEAT', 'BUG', 'REVIEW', 'CHORE', 'TEST', 'PERSO']
# Root names that map to the 'personal' scope (vault selection, v1 fallback).
PERSONAL_ROOTS = ('perso', 'personal', 'personnel')


def expand(p):
    if not isinstance(p, str):
        return p
    if p == '~':
        return HOME
    if p.startswith('~/'):
        return os.path.join(HOME, p[2:])
    return p


def load():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except Exception:
        return {}


def categories(cfg):
    return [c for c in cfg.get('categories', []) if isinstance(c, dict) and c.get('name')]


def category_names(cfg):
    # Distinct names, order-preserving (a name may repeat across roots).
    out, seen = [], set()
    for c in categories(cfg):
        if c['name'] not in seen:
            out.append(c['name'])
            seen.add(c['name'])
    return out or list(DEFAULT_CATEGORIES)


def roots_list(cfg):
    """[(name, path)] — explicit v2 `roots`, else migrate v1 workRoot/personalRoot
    to Work + Perso. Mirrors config.rs derive()."""
    rs = cfg.get('roots')
    if isinstance(rs, list):
        out = [(r['name'], expand(r.get('path') or HOME))
               for r in rs if isinstance(r, dict) and r.get('name')]
        if out:
            return out
    work = expand(cfg.get('workRoot') or os.path.join(HOME, 'work'))
    perso = expand(cfg.get('personalRoot') or HOME)
    return [('Work', work), ('Perso', perso)]


def root_path(cfg, root_name):
    for name, path in roots_list(cfg):
        if name == root_name:
            return path
    return None


def root_name_of(entry):
    """The root a category entry lives under: v2 `root`, else migrated from `scope`."""
    r = entry.get('root')
    if isinstance(r, str) and r.strip():
        return r.strip()
    return 'Perso' if entry.get('scope') == 'personal' else 'Work'


def find_entry(cfg, name, root=None):
    for c in categories(cfg):
        if c.get('name') == name and (root is None or root_name_of(c) == root):
            return c
    return None


def base_for_entry(cfg, entry):
    name = entry.get('name', '')
    path = root_path(cfg, root_name_of(entry))
    if path is None:
        # Root name not in the declared roots list — only reachable via a hand-edited
        # config (the dashboard keeps roots + categories in sync). Fall back to workRoot
        # to MATCH config.rs derive() (`root_path(...).unwrap_or(work_root)`). Diverging
        # here (e.g. by scope) would point the scanner and the skills at different dirs,
        # so a session created by a skill would vanish from the dashboard.
        path = expand(cfg.get('workRoot') or os.path.join(HOME, 'work'))
    return os.path.join(path, name)


def base_for(cfg, name, root=None):
    entry = find_entry(cfg, name, root)
    if entry is None:
        # Unknown category — synthesise an entry, honouring an explicit root.
        entry = {'name': name}
        if root:
            entry['root'] = root
    return base_for_entry(cfg, entry)


def scope_of(cfg, name):
    entry = find_entry(cfg, name)
    if entry is None:
        return 'work'
    if entry.get('scope'):
        return entry['scope']
    return 'personal' if root_name_of(entry).lower() in PERSONAL_ROOTS else 'work'


def vault_for(cfg, name):
    """Obsidian vault path for a category's root.

    v2: the vault lives on the category's root (roots[].vaultPath).
    v1 shim: scope → workVaultPath/personalVaultPath (remove in ADR-015 Release N+1).
    """
    # `knowledge` is current, `obsidian` legacy — this reads the raw config file, which
    # only gains the new name once the app next saves it.
    obs = cfg.get('knowledge') or cfg.get('obsidian') or {}
    if not obs.get('enabled'):
        return ''

    # v2: read vaultPath from the category's root.
    entry = find_entry(cfg, name)
    if entry:
        root_name = root_name_of(entry)
        # Look up the root in the raw config to get its vaultPath.
        roots = cfg.get('roots', [])
        if isinstance(roots, list):
            for r in roots:
                if isinstance(r, dict) and r.get('name') == root_name:
                    vp = expand(r.get('vaultPath', '') or '')
                    if vp:
                        return vp
                    break  # root found but carries no vault → fall through to the v1 shim

    # v1 shim: scope → workVaultPath/personalVaultPath.
    # Keep until ADR-015 Release N+1.
    key = 'personalVaultPath' if scope_of(cfg, name) == 'personal' else 'workVaultPath'
    return expand(obs.get(key) or '')


def vaults(cfg):
    """Every distinct configured Obsidian vault path, in root order.

    `vault_for` answers "which vault for THIS category"; this answers "all of them", for
    a caller that has no category to key off (an unmanaged terminal). Space names never
    appear — users name their own spaces, so a skill must resolve through the config
    rather than hardcode a name or a path.
    """
    # `knowledge` is current, `obsidian` legacy — this reads the raw config file, which
    # only gains the new name once the app next saves it.
    obs = cfg.get('knowledge') or cfg.get('obsidian') or {}
    if not obs.get('enabled'):
        return []
    out = []
    roots = cfg.get('roots')
    if isinstance(roots, list):
        for r in roots:
            if isinstance(r, dict):
                vp = expand(r.get('vaultPath', '') or '')
                if vp and vp not in out:
                    out.append(vp)
    if out:
        return out
    # v1 shim, same order as roots_list's fallback (Work then Perso).
    for key in ('workVaultPath', 'personalVaultPath'):
        vp = expand(obs.get(key) or '')
        if vp and vp not in out:
            out.append(vp)
    return out


# Keys that default ON when absent. A config written before the key existed must not
# silently disable behaviour the product ships as its default — that reads as a dead
# feature rather than an opt-out, and it is invisible from the outside.
DEFAULT_ON_FLAGS = ('skillProposals',)


def flag(cfg, key):
    """A boolean flag from the config root. Prints 'on'/'' so a shell `[ -n ... ]` test
    reads naturally. An absent key is off, except for DEFAULT_ON_FLAGS; an explicit
    `false` always wins, so opting out stays possible."""
    value = cfg.get(key)
    if value is None:
        return 'on' if key in DEFAULT_ON_FLAGS else ''
    return 'on' if value is True else ''


def find_notes(cfg, slug):
    out, seen = [], set()
    entries = categories(cfg) or [{'name': n} for n in DEFAULT_CATEGORIES]
    for c in entries:
        p = os.path.join(base_for_entry(cfg, c), slug, 'notes.md')
        if p not in seen and os.path.isfile(p):
            out.append(p)
            seen.add(p)
    return out


def main():
    args = sys.argv[1:]
    cfg = load()
    if not args:
        print("usage: aoconfig.py categories|roots|rootpath|root|scope|base|dir|vault|vaults|flag|find [args]")
        return
    cmd = args[0]
    if cmd == 'categories':
        print('\n'.join(category_names(cfg)))
    elif cmd == 'roots':
        print('\n'.join(name for name, _ in roots_list(cfg)))
    elif cmd == 'rootpath' and len(args) >= 2:
        print(root_path(cfg, args[1]) or '')
    elif cmd == 'find' and len(args) >= 2:
        print('\n'.join(find_notes(cfg, args[1])))
    elif cmd == 'root' and len(args) >= 2:
        entry = find_entry(cfg, args[1]) or {'name': args[1]}
        print(root_name_of(entry))
    elif cmd == 'vaults':
        print('\n'.join(vaults(cfg)))
    elif cmd == 'flag' and len(args) >= 2:
        print(flag(cfg, args[1]))
    elif cmd in ('scope', 'vault') and len(args) >= 2:
        print({'scope': scope_of, 'vault': vault_for}[cmd](cfg, args[1]))
    elif cmd == 'base' and len(args) >= 2:
        print(base_for(cfg, args[1], args[2] if len(args) >= 3 else None))
    elif cmd == 'dir' and len(args) >= 3:
        root = args[3] if len(args) >= 4 else None
        print(os.path.join(base_for(cfg, args[1], root), args[2]))
    else:
        print(f"bad usage for '{cmd}'", file=sys.stderr)
        sys.exit(1)


main()
