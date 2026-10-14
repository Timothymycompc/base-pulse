#!/bin/bash
# Save any uncommitted site or server changes, push to GitHub, then deploy.
# Stops at the first failed step. Safe to run again: done steps are skipped.
cd "$(dirname "$0")/.." || exit 1
step() { local name=$1; echo "== $name"; shift; "$@" || { echo "FAILED at: $name. Nothing after this step ran."; exit 1; }; }

FILES="README.md PRINCIPLES.md LATER.md DEVELOPING.md index.html package.json package-lock.json server scripts src tests .env.example"
if [ -n "$(git status --porcelain -- $FILES)" ]; then
  step "Run the tests" timeout 300 npm test --silent
  step "Stage the changes" git add -- $FILES
  # A message naming the changed files, never a leftover one: a fixed message here once labelled a whole
  # UI rework as "Connect page" setup. Pass your own as the first argument: ~/ship.sh "What changed"
  MSG="${1:-Update $(git status --porcelain -- $FILES | awk '{print $2}' | head -8 | paste -sd, - | sed 's/,/, /g')}"
  step "Save the changes" git commit -q -m "$MSG" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
else
  echo "== Changes already saved"
fi

step "Push to GitHub" timeout 120 git push origin main

echo "== Deploy (5 to 15 minutes)"
timeout 1500 npm run deploy; ec=$?
if [ $ec -eq 124 ]; then echo "STUCK: deploy killed after 25 minutes"
elif [ $ec -eq 0 ]; then echo "ALL DONE"
else echo "DEPLOY FAILED (exit $ec)"; fi
