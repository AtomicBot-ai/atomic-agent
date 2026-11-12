#!/usr/bin/env bash
# Read-only preflight for the publish-site skill. Looks at a static site
# folder before it goes public and prints what would be published plus
# anything that must not be. Changes nothing, sends nothing.
#
# Usage: check-site.sh <site-folder>
# Exit:  0 = ok or warnings only, 1 = blocked (secrets or key files found),
#        2 = not a publishable folder (missing, or no index.html).
set -u

dir="${1:-}"
if [ -z "$dir" ]; then
  echo "usage: check-site.sh <site-folder>"
  exit 2
fi
if [ ! -d "$dir" ]; then
  echo "BLOCKED: folder not found: $dir"
  echo "RESULT: not-a-site"
  exit 2
fi
dir="${dir%/}"
if [ ! -f "$dir/index.html" ]; then
  echo "BLOCKED: no index.html at the top of $dir (build the site first, or point at the build output folder)"
  echo "RESULT: not-a-site"
  exit 2
fi

blocked=0
warned=0

rel() {
  printf '%s' "${1#"$dir"/}"
}

files=$(find "$dir" \( -name .git -o -name node_modules \) -prune -o -type f -print | wc -l | tr -d ' ')
size_kb=$(du -sk "$dir" 2>/dev/null | awk '{print $1}')
echo "folder: $dir"
echo "files: $files"
echo "size_kb: ${size_kb:-unknown}"

# Files that hold credentials or private keys never go on a public site.
key_files=$(find "$dir" \( -name .git -o -name node_modules \) -prune -o -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' \
  -o -name '*.pfx' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.npmrc' \
  -o -name '.netrc' -o -name 'credentials*.json' \) -print)
if [ -n "$key_files" ]; then
  blocked=1
  printf '%s\n' "$key_files" | while IFS= read -r f; do
    echo "BLOCKED: secret-looking file: $(rel "$f")"
  done
fi

# Secret-looking strings inside text files.
secret_re='(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
secret_hits=$(grep -rIlE --exclude-dir=.git --exclude-dir=node_modules "$secret_re" "$dir" 2>/dev/null)
if [ -n "$secret_hits" ]; then
  blocked=1
  printf '%s\n' "$secret_hits" | while IFS= read -r f; do
    echo "BLOCKED: file contains a key or token: $(rel "$f")"
  done
fi

if [ -d "$dir/.git" ]; then
  warned=1
  echo "WARN: .git folder inside the site folder; copy the files without it"
fi
if [ -d "$dir/node_modules" ]; then
  warned=1
  echo "WARN: node_modules inside the site folder; this looks like a project, not its build output"
fi

big=$(find "$dir" \( -name .git -o -name node_modules \) -prune -o -type f -size +102400k -print)
if [ -n "$big" ]; then
  warned=1
  printf '%s\n' "$big" | while IFS= read -r f; do
    echo "WARN: file over 100 MB (GitHub rejects it): $(rel "$f")"
  done
fi
if [ -n "${size_kb:-}" ] && [ "$size_kb" -gt 1048576 ]; then
  warned=1
  echo "WARN: site is over 1 GB (GitHub Pages limit)"
fi

# Root-absolute links break when the site is served from a sub-path,
# e.g. a GitHub Pages project site at https://<user>.github.io/<repo>/.
abs_links=$(grep -rIlE --include='*.html' --exclude-dir=.git --exclude-dir=node_modules \
  '(href|src)="/[^/"]' "$dir" 2>/dev/null)
if [ -n "$abs_links" ]; then
  warned=1
  printf '%s\n' "$abs_links" | while IFS= read -r f; do
    echo "WARN: root-absolute link (href=\"/...\" or src=\"/...\") in $(rel "$f"); breaks on a sub-path site"
  done
fi

if [ "$blocked" -eq 1 ]; then
  echo "RESULT: blocked"
  exit 1
fi
if [ "$warned" -eq 1 ]; then
  echo "RESULT: warnings"
  exit 0
fi
echo "RESULT: ok"
exit 0
