#!/usr/bin/env bash
# Install the bundled session skills + seed the shared config.
#
#   bash scripts/install.sh              # install (won't overwrite existing skills)
#   bash scripts/install.sh --force      # overwrite existing skills
#   bash scripts/install.sh --with-hooks # also copy the optional PR-attach + learn-nudge hooks
#
# Copies skills/* → ~/.claude/skills/, writes a default config if none exists, and
# creates the category folders. Never touches your session data.
set -euo pipefail
shopt -s nullglob

FORCE=0; HOOKS=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --with-hooks) HOOKS=1 ;;
  esac
done
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
    # Mirror the pristine snapshot the app's installer keeps (src-tauri/src/skills.rs):
    # the app's launch sync compares each skill against .ao-base/<name> to tell "edited
    # by hand" (back it up first) from "just stale" (overwrite plainly). A skill this
    # script wrote without refreshing its base would look hand-edited to the app forever.
    rm -rf "$SKILLS_DST/.ao-base/$name"
    mkdir -p "$SKILLS_DST/.ao-base"
    cp -R "$d" "$SKILLS_DST/.ao-base/$name"
  fi
done

# Stamp the same marker the app's own installer writes (src-tauri/src/skills.rs), so
# whichever ran LAST — this script or the app's Settings button — leaves a record the
# other side can compare against. Only when nothing above is stale: a STALE entry means
# the tree does NOT fully match this checkout, and claiming this checkout's date here
# would tell a later, older app build "you'd be going backward" when you wouldn't.
if [ ${#STALE[@]} -eq 0 ]; then
  epoch="$(git -C "$HERE" log -1 --format=%ct -- skills 2>/dev/null || true)"
  if [ -n "$epoch" ]; then
    printf '{"bundle_epoch": %s}' "$epoch" > "$SKILLS_DST/.ao-install-manifest.json"
  fi
fi

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

# 5. Optional PR-attach hook. Copying the script is safe; wiring it is not, so the
# settings.json entry is printed for you to paste — this installer never edits the file
# that decides which code Claude Code runs on your machine.
if [ "$HOOKS" -eq 1 ]; then
  mkdir -p "$HOME/.claude/hooks"
  cp "$HERE/hooks/pr_attach.py" "$HOME/.claude/hooks/pr_attach.py"
  echo
  echo "installed hook script: ~/.claude/hooks/pr_attach.py"
  echo "  To enable it, add this to the PostToolUse \"Bash\" hooks in ~/.claude/settings.json:"
  echo '    { "type": "command", "command": "IN=$(cat); printf '"'"'%s'"'"' \"$IN\" | python3 \"$HOME/.claude/hooks/pr_attach.py\" 2>/dev/null; true" }'
  echo "  It attaches a PR to the session notes the moment \`gh pr create\` opens it."
  echo
  cp "$HERE/hooks/learn_nudge.py" "$HOME/.claude/hooks/learn_nudge.py"
  echo "installed hook script: ~/.claude/hooks/learn_nudge.py"
  echo "  To enable it, add this to the UserPromptSubmit hooks in ~/.claude/settings.json:"
  echo '    { "hooks": [ { "type": "command", "command": "python3 \"$HOME/.claude/hooks/learn_nudge.py\" 2>/dev/null; true" } ] }'
  echo "  It nudges the model to check /learn or /skill-propose the moment a message reads"
  echo "  like a standing preference or correction (\"always\", \"from now on\", \"ne ... plus\"...)."
fi

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
