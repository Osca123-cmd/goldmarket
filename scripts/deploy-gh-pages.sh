#!/usr/bin/env bash
# Build statis dengan basePath /goldmarket dan publikasikan ke branch gh-pages
# (GitHub Pages: https://osca123-cmd.github.io/goldmarket/).
set -euo pipefail
cd "$(dirname "$0")/.."
NEXT_PUBLIC_BASE_PATH=/goldmarket npx next build
tmp=$(mktemp -d)
git worktree add -f "$tmp" gh-pages 2>/dev/null || git worktree add -f -B gh-pages "$tmp" origin/gh-pages
find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r out/. "$tmp"/ && touch "$tmp/.nojekyll"
git -C "$tmp" add -A
git -C "$tmp" commit -m "Deploy GOLDMARKET static build" || echo "Tidak ada perubahan."
git -C "$tmp" push origin gh-pages
git worktree remove --force "$tmp"
