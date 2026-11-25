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
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" \
  commit -q -m "Deploy $revision"
git push -q --force "$remote" gh-pages
echo "Published $revision to gh-pages"
