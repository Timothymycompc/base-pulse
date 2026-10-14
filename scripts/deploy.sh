#!/usr/bin/env bash
# Smart deploy for Base Pulse.
#   npm run deploy                 full run
#   npm run deploy -- --no-backup  skip the database backup
#   npm run deploy -- --skip-local skip the local typecheck/build (not recommended)
#   npm run deploy -- --check-only run the setup and code checks, then stop before uploading
#
# Safe by design: the new version is deployed with no traffic, tested at its own URL,
# and only then made live. If anything fails, the current site keeps running untouched.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SVC=base-pulse
DB_NAME=base_pulse
REGION=us-central1
SQL_INSTANCE=solana-pulse-db
BACKUP=1; LOCAL=1; CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-backup) BACKUP=0 ;;
    --skip-local) LOCAL=0 ;;
    --check-only) CHECK_ONLY=1 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
stop() { printf '\n\033[31mStopped:\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf 'What to do: %s\n' "$2"; printf 'Your live site was not changed.\n'; exit 1; }

# ---------- 1. Setup ----------
bold "1/6  Checking your setup"
command -v gcloud >/dev/null || stop "gcloud is not installed." "Install the Google Cloud CLI, then run: gcloud auth login"
ACCOUNT=$(gcloud config get-value account 2>/dev/null)
[ -n "$ACCOUNT" ] || stop "You are not logged in to Google Cloud." "Run: gcloud auth login"
ok "Logged in as $ACCOUNT"
PREV=$(gcloud run services describe $SVC --region $REGION --format='value(status.latestReadyRevisionName)' 2>/dev/null)
if [ -n "$PREV" ]; then ok "Live version: $PREV"; else warn "No live version yet: this is the first deploy."; fi
for SECRET in BASE_PULSE_DATABASE_URL OWNER_API_KEY BASE_RPC_URL CALLER_HASH_SECRET; do
  if gcloud secrets describe $SECRET >/dev/null 2>&1; then ok "Secret $SECRET exists"
  elif [ $SECRET = BASE_PULSE_DATABASE_URL ]; then stop "Secret BASE_PULSE_DATABASE_URL is missing; the server cannot start without it." "Create the $DB_NAME database and its secret first (see README)."
  else warn "Secret $SECRET is missing (the site works, but $([ $SECRET = BASE_RPC_URL ] && echo 'it uses the slow public RPC' || echo "$SECRET is not set"))."; fi
done
grep -qE 'GATEWAY_WALLET = "0x[0-9a-fA-F]{40}"' server/index.ts && ok "Payout wallet set" || stop "No payout wallet in server/index.ts." "Set GATEWAY_WALLET to the Base address that receives payments."
[ -z "$(git status --porcelain)" ] && ok "No uncommitted changes" || warn "You have uncommitted changes; they will be deployed but are not saved in git."

# ---------- 2. Local checks ----------
bold "2/6  Testing the code on this device"
if [ $LOCAL = 1 ]; then
  [ -d node_modules ] || { echo "  Installing dependencies…"; npm install --no-audit --no-fund >/tmp/base-pulse-install.log 2>&1 || stop "npm install failed (see /tmp/base-pulse-install.log)." "Check your internet connection and run npm install."; }
  if npx tsc --noEmit >/tmp/base-pulse-tsc.log 2>&1; then ok "Type check passed"
  else fail "Type check failed:"; head -20 /tmp/base-pulse-tsc.log | sed 's/^/      /'; stop "The code has type errors." "Fix the errors listed above (file:line), commit, and run npm run deploy again."; fi
  if npx vite build >/tmp/base-pulse-build.log 2>&1 && npx esbuild server/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=/tmp/base-pulse-server.cjs >>/tmp/base-pulse-build.log 2>&1; then ok "Build passed"
  else fail "Build failed:"; grep -iE "error|failed" /tmp/base-pulse-build.log | head -15 | sed 's/^/      /'; stop "The build failed." "Fix the errors above, then run npm run deploy again."; fi
  rm -rf dist
else warn "Skipped (--skip-local)"; fi

if [ $CHECK_ONLY = 1 ]; then printf '\n\033[32mReady to deploy.\033[0m Run npm run deploy when you want to go live.\n'; exit 0; fi

TOOL_COUNT=$(npx tsx -e 'import("./server/tools/index.ts").then(m=>console.log(m.TOOLS.length))' 2>/dev/null)
[ -n "$TOOL_COUNT" ] || TOOL_COUNT='[0-9]*'

# ---------- 3. Backup ----------
bold "3/6  Backing up the database"
if [ $BACKUP = 1 ]; then
  gcloud sql backups create --instance=$SQL_INSTANCE --description="before $(git rev-parse --short HEAD)" >/tmp/base-pulse-backup.log 2>&1 \
    && ok "Backup created" || { tail -3 /tmp/base-pulse-backup.log | sed 's/^/      /'; stop "The database backup failed." "Retry, or run with --no-backup if you are sure."; }
else warn "Skipped (--no-backup)"; fi

# ---------- 4. Deploy without traffic ----------
bold "4/6  Uploading and starting the new version (no visitors yet)"
COMMIT=$(git rev-parse --short HEAD)
# The first deploy creates the service with its database, secrets and settings; there is no live site to protect yet.
if [ -z "$PREV" ]; then
  DEPLOY=(gcloud run deploy $SVC --source . --region $REGION --allow-unauthenticated --tag candidate --update-labels commit=$COMMIT --quiet
    --add-cloudsql-instances x300-506418:$REGION:$SQL_INSTANCE --set-env-vars GCP_PROJECT_ID=x300-506418
    --set-secrets DATABASE_URL=BASE_PULSE_DATABASE_URL:latest --memory 512Mi --max-instances 20 --cpu-boost)
else
  DEPLOY=(gcloud run deploy $SVC --source . --region $REGION --no-traffic --tag candidate --update-labels commit=$COMMIT --quiet)
fi
if ! "${DEPLOY[@]}" >/tmp/base-pulse-deploy.log 2>&1; then
  NEW=$(gcloud run services describe $SVC --region $REGION --format='value(status.latestCreatedRevisionName)')
  fail "The new version ($NEW) did not start. Reading its logs…"
  LOGS=$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$NEW\"" --limit=80 --format='value(textPayload)' 2>/dev/null)
  echo "$LOGS" | grep -E "^error|Error:|error:|ERROR|Cannot|cannot|ECONN|refused|denied|not found|exit\(" | grep -v "^\s*at " | head -8 | sed 's/^/      /'
  HINT="Paste the lines above to Claude, or open: https://console.cloud.google.com/run/detail/$REGION/$SVC/logs"
  echo "$LOGS" | grep -q "ECONNREFUSED\|password authentication failed\|DATABASE_URL" && HINT="The server could not reach the database. Check the DATABASE_URL secret and the Cloud SQL connection."
  echo "$LOGS" | grep -q "cannot drop\|depends on" && HINT="A database cleanup step failed; this release should log it instead of crashing. Pull the latest code."
  echo "$LOGS" | grep -q "Cannot find module" && HINT="A package is missing. Run npm install, commit package-lock.json, and deploy again."
  echo "$LOGS" | grep -q "Permission denied\|PERMISSION_DENIED" && HINT="Cloud Run cannot read a secret. Grant the service account access (secretmanager.secretAccessor)."
  grep -iE "error" /tmp/base-pulse-deploy.log | tail -3 | sed 's/^/      /'
  stop "The new version failed to start." "$HINT"
fi
NEW=$(gcloud run services describe $SVC --region $REGION --format='value(status.latestCreatedRevisionName)')
TEST_URL=$(gcloud run services describe $SVC --region $REGION --format=json | python3 -c "import sys,json;print(next((t['url'] for t in json.load(sys.stdin)['status'].get('traffic',[]) if t.get('tag')=='candidate'),''))")
[ -n "$TEST_URL" ] || stop "Could not find the test URL for $NEW." "Run: gcloud run services describe $SVC --region $REGION"
ok "New version $NEW is running at its test URL"

# ---------- 5. Checks ----------
check_all() {
  local B=$1 FAILS=0
  c() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else fail "$1"; FAILS=$((FAILS+1)); fi; }
  c "All tools live"         "curl -s -m 20 $B/api/debug/build | grep -q '\"tools\":$TOOL_COUNT'"
  c "MCP lists tools"        "curl -s -m 20 -X POST $B/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q balance"
  c "A tool runs (free call)" "curl -s -m 30 -X POST $B/api/tools/balance -H 'content-type: application/json' -d '{\"wallet\":\"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\"}' | grep -q '\"eth_wei\"'"
  c "Live examples load"     "curl -s -m 30 $B/api/tools/balance/example | grep -q '\"arguments\"'"
  c "Tool docs"              "curl -s -m 20 $B/api/tools | grep -q '\"howWorkedOut\"'"
  c "mcp.json lists x402"    "curl -s -m 20 $B/.well-known/mcp.json | grep -q '\"protocol\":\"x402\"'"
  c "glama.json"             "curl -s -m 20 $B/.well-known/glama.json | grep -q maintainers"
  c "llms.txt"               "curl -s -m 20 $B/llms.txt | grep -q balance"
  c "Free-call status"       "curl -s -m 20 $B/api/trial/status | grep -q '\"freeCallsPerTool\":[0-9]'"
  c "Web page loads"         "curl -s -m 20 $B/docs/tools/balance | grep -q '<div id=\"root\">'"
  return $FAILS
}
bold "5/6  Checking the new version before anyone sees it"
if ! check_all "$TEST_URL"; then
  stop "Some checks failed on the new version, so it was NOT made live." "Paste this output to Claude. The test version stays reachable at $TEST_URL for debugging."
fi

# ---------- 6. Go live ----------
bold "6/6  Making it live"
gcloud run services update-traffic $SVC --region $REGION --to-latest --quiet >/tmp/base-pulse-traffic.log 2>&1 \
  || { tail -3 /tmp/base-pulse-traffic.log | sed 's/^/      /'; stop "Could not switch traffic to $NEW." "Retry: gcloud run services update-traffic $SVC --region $REGION --to-revisions=$NEW=100"; }
ok "All visitors now use $NEW (was ${PREV:-nothing, first deploy})"
LIVE_URL=$(gcloud run services describe $SVC --region $REGION --format='value(status.url)')
sleep 3
curl -s -m 20 "$LIVE_URL/api/debug/build" | grep -q '"tools":' && ok "Live site answering" || warn "Live site did not answer yet; it can take a few seconds."
printf '\n\033[32mDeployed %s.\033[0m To undo: gcloud run services update-traffic %s --region %s --to-revisions=%s=100\n' "$COMMIT" "$SVC" "$REGION" "$PREV"
