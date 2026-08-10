#!/usr/bin/env bash
# Install the bundled session skills + seed the shared config.
#
#   bash scripts/install.sh           # install (won't overwrite existing skills)
#   bash scripts/install.sh --force   # overwrite existing skills
#
# Copies skills/* → ~/.claude/skills/, writes a default config if none exists, and
# creates the category folders. Never touches your session data.
set -euo pipefail
shopt -s nullglob

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$HERE/skills"
SKILLS_DST="$HOME/.claude/skills"
CONFIG_DIR="$HOME/.config/ai-agents-orchestrator"
CONFIG="$CONFIG_DIR/config.json"

echo "AI Agents Orchestrator — installing skills + config"
echo

# 1. Shared helper (always refreshed — not user-customised)
mkdir -p "$SKILLS_DST/lib"
cp "$SKILLS_SRC/lib/"*.py "$SKILLS_DST/lib/"
echo "installed: lib/ (config helper)"

# 2. Skills (don't clobber a user's customised skill without --force)
STALE=()
for d in "$SKILLS_SRC"/*/; do
  name="$(basename "$d")"
  [ "$name" = "lib" ] && continue
  dst="$SKILLS_DST/$name"
  if [ -e "$dst" ] && [ "$FORCE" -ne 1 ]; then
    echo "skip (exists): /$name  — use --force to overwrite"
    # Skipping an IDENTICAL copy is a no-op; skipping a CHANGED one silently leaves the
    # user on an old version, which is how a shipped fix quietly fails to arrive.
    diff -rq "$d" "$dst" >/dev/null 2>&1 || STALE+=("$name")
  else
    rm -rf "$dst"; cp -R "$d" "$dst"; echo "installed skill: /$name"
  fi
done

# 3. Seed the config if absent (the app's Settings edits the same file)
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'JSON'
{
  "version": 2,
  "roots": [
    { "name": "Work",  "path": "~/work", "vaultPath": "" },
    { "name": "Perso", "path": "~", "vaultPath": "" }
  ],
  "categories": [
    { "name": "FEAT",   "color": "#7df0c0", "root": "Work" },
    { "name": "BUG",    "color": "#ff9eb1", "root": "Work" },
    { "name": "REVIEW", "color": "#d9a86e", "root": "Work" },
    { "name": "CHORE",  "color": "#ffe17a", "root": "Work" },
    { "name": "TEST",   "color": "#cdd0d6", "root": "Work" },
    { "name": "PERSO",  "color": "#8fd9ff", "root": "Perso" }
  ],
  "obsidian": { "enabled": false },
  "ticketBaseUrl": ""
}
JSON
  echo "wrote default config: $CONFIG"
else
  echo "config exists (kept): $CONFIG"
fi

# 4. Create each category's folder (so /start-session has somewhere to write)
echo "creating category folders:"
python3 "$SKILLS_DST/lib/aoconfig.py" categories | while IFS= read -r cat; do
  [ -z "$cat" ] && continue
  base="$(python3 "$SKILLS_DST/lib/aoconfig.py" base "$cat")"
  mkdir -p "$base" && echo "  $base"
done

echo
if [ ${#STALE[@]} -gt 0 ]; then
  echo "⚠ ${#STALE[@]} installed skill(s) are OLDER than this version and were kept:"
  printf '    /%s\n' "${STALE[@]}"
  echo "  Their updates did NOT arrive. If you have not customised them, re-run:"
  echo "    bash scripts/install.sh --force"
  echo
fi
echo "✓ Done. Edit categories/colors/paths in the app's Settings (⚙), or in $CONFIG."
echo "→ Optional: install the Superpowers plugin for git-worktree support:"
echo "    https://github.com/obra/superpowers"
printf 'Skills available now:'
for d in "$SKILLS_SRC"/*/; do
  name="$(basename "$d")"
  [ "$name" = "lib" ] && continue
  printf '  /%s' "$name"
done
echo
