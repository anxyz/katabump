#!/usr/bin/env bash
set -euo pipefail

git config user.name "$GITHUB_REPOSITORY_OWNER"
git config user.email "${ACTIVITY_OWNER_ID}+${GITHUB_REPOSITORY_OWNER}@users.noreply.github.com"
for attempt in 1 2 3; do
  git fetch origin "$ACTIVITY_BRANCH"
  git checkout --detach FETCH_HEAD
  if [ -f .last-active ]; then
    previous=$(date -u -d "$(cat .last-active)" +%s 2>/dev/null || printf '0')
    current=$(date -u +%s)
    if [ "$previous" -gt 0 ] && [ "$previous" -le "$current" ] && [ "$((current - previous))" -lt 604800 ]; then
      exit 0
    fi
  fi
  date -u +'%Y-%m-%dT%H:%M:%SZ' > .last-active
  git add -- .last-active
  if git diff --cached --quiet; then
    exit 0
  fi
  git commit --allow-empty-message -m ''
  if git push origin "HEAD:refs/heads/$ACTIVITY_BRANCH"; then
    exit 0
  fi
  sleep 2
done
exit 1
