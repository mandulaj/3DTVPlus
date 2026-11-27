#!/usr/bin/env sh
# Builds the app (one page plus its data files) and publishes it to the gh-pages branch (GitHub Pages).
# Usage: npm run deploy
set -eu
cd "$(dirname "$0")/.."
remote=$(git remote get-url origin)
revision=$(git rev-parse --short HEAD)
npm test
npm run build
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R dist/. "$tmp/" # the page and the data files stored next to it
# Keep the scheduled workflow's refreshed condition reports if gh-pages has a newer copy.
if git fetch -q origin gh-pages 2>/dev/null && git cat-file -e origin/gh-pages:data/gipfelbuch.json 2>/dev/null; then
  node -e '
    const { execFileSync } = require("node:child_process");
    const { readFileSync, writeFileSync } = require("node:fs");
    const dest = process.argv[1];
    const remote = execFileSync("git", ["show", "origin/gh-pages:data/gipfelbuch.json"], { encoding: "utf8" });
    const local = readFileSync(dest, "utf8");
    if ((JSON.parse(remote).updated ?? "") > (JSON.parse(local).updated ?? "")) writeFileSync(dest, remote);
  ' "$tmp/data/gipfelbuch.json" 2>/dev/null || true
fi
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" \
  commit -q -m "Deploy $revision"
git push -q --force "$remote" gh-pages
echo "Published $revision to gh-pages"
