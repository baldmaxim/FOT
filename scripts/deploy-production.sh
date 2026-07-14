#!/usr/bin/env bash
# Thin production deploy launcher for fot.su10.ru.
#
# The actual deploy runs on the production server from BUILD_DIR
# (/opt/fot-build by default). The server syncs git there, builds there, and
# publishes only built artifacts into /srv/sites/fot.su10.ru.
#
# This local wrapper exists only for convenience. It must not build or upload
# local working-tree files.

set -euo pipefail

FOT_SSH="${FOT_SSH:-root@45.80.128.254}"
BUILD_DIR="${BUILD_DIR:-/opt/fot-build}"
FOT_REPO_URL="${FOT_REPO_URL:-https://github.com/baldmaxim/FOT.git}"
FOT_REMOTE="${FOT_REMOTE:-personal}"
FOT_BRANCH="${FOT_BRANCH:-main}"

SCOPE="${1:-both}"
MODE_ARG=""
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-production.sh [frontend|backend|data-api|both|all] [--check]

This is a thin SSH launcher. It does not build locally and does not upload
local files. On the production server it ensures the build context exists,
then runs:

  cd /opt/fot-build
  bash scripts/deploy-server.sh <scope>

The server-side deploy syncs /opt/fot-build from git, builds there, and copies
only artifacts into /srv/sites/fot.su10.ru.

Scopes:
  frontend   Deploy fot-app/dist only.
  backend    Deploy fot-server/dist and restart fot-server.
  data-api   Deploy fot-data-api/app and restart fot-data-api.
  both       Deploy backend + frontend. Default.
  all        Deploy backend + frontend + data-api.
  migrate    Run pending SQL migrations on the server (no build/restart).
             Flags (migrate only): --dry-run, --baseline, --init.

Environment:
  FOT_SSH=root@45.80.128.254
  BUILD_DIR=/opt/fot-build
  FOT_REPO_URL=https://github.com/baldmaxim/FOT.git
  FOT_REMOTE=personal
  FOT_BRANCH=main

Forwarded to scripts/deploy-server.sh when set:
  SITE_DIR
  EXPECTED_HOSTNAME
  ALLOW_HOSTNAME_MISMATCH
  BUILD_CLEAN_HARD
  FRONTEND_NPM_CI
  BACKEND_NPM_CI
  BACKEND_SOURCEMAPS
  DATA_API_PIP_INSTALL
  SKIP_VERIFY

Examples:
  bash scripts/deploy-production.sh --check
  bash scripts/deploy-production.sh frontend
  BACKEND_NPM_CI=1 bash scripts/deploy-production.sh backend
  bash scripts/deploy-production.sh all
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "-> $*"
}

case "$SCOPE" in
  --check)
    MODE_ARG="--check"
    SCOPE="both"
    shift || true
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  frontend|backend|data-api|both|all|migrate)
    shift || true
    ;;
  *)
    usage >&2
    die "unknown scope: $SCOPE"
    ;;
esac

while (($#)); do
  case "$1" in
    --check)
      MODE_ARG="--check"
      ;;
    --dry-run|--baseline|--init)
      [[ "$SCOPE" == "migrate" ]] || die "$1 is allowed only with scope migrate"
      EXTRA_ARGS+=("$1")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
  shift
done

shell_quote() {
  printf "%q" "$1"
}

remote_env=(
  "BUILD_DIR=$(shell_quote "$BUILD_DIR")"
  "FOT_REPO_URL=$(shell_quote "$FOT_REPO_URL")"
  "FOT_REMOTE=$(shell_quote "$FOT_REMOTE")"
  "FOT_BRANCH=$(shell_quote "$FOT_BRANCH")"
  "DEPLOY_SCOPE=$(shell_quote "$SCOPE")"
  "DEPLOY_MODE_ARG=$(shell_quote "$MODE_ARG")"
  "DEPLOY_EXTRA_ARGS=$(shell_quote "${EXTRA_ARGS[*]-}")"
)

forward_if_set() {
  local name="$1"
  if [[ -n "${!name+x}" ]]; then
    remote_env+=("$name=$(shell_quote "${!name}")")
  fi
}

for name in \
  SITE_DIR \
  EXPECTED_HOSTNAME \
  ALLOW_HOSTNAME_MISMATCH \
  BUILD_CLEAN_HARD \
  FRONTEND_NPM_CI \
  BACKEND_NPM_CI \
  BACKEND_SOURCEMAPS \
  DATA_API_PIP_INSTALL \
  SKIP_VERIFY
do
  forward_if_set "$name"
done

remote_script="$(cat <<'REMOTE'
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command not found on server: $1" >&2
    exit 1
  }
}

require_cmd bash
require_cmd git

if [[ ! -d "$BUILD_DIR/.git" ]]; then
  echo "-> Creating build context: $BUILD_DIR"
  rm -rf "$BUILD_DIR"
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone "$FOT_REPO_URL" "$BUILD_DIR"
fi

cd "$BUILD_DIR"

if git remote get-url "$FOT_REMOTE" >/dev/null 2>&1; then
  git remote set-url "$FOT_REMOTE" "$FOT_REPO_URL"
elif [[ "$FOT_REMOTE" == "personal" ]] && git remote get-url origin >/dev/null 2>&1; then
  git remote rename origin "$FOT_REMOTE" 2>/dev/null || true
  git remote set-url "$FOT_REMOTE" "$FOT_REPO_URL" 2>/dev/null || git remote add "$FOT_REMOTE" "$FOT_REPO_URL"
else
  git remote add "$FOT_REMOTE" "$FOT_REPO_URL"
fi

args=("$DEPLOY_SCOPE")
if [[ -n "$DEPLOY_MODE_ARG" ]]; then
  args+=("$DEPLOY_MODE_ARG")
fi
if [[ -n "${DEPLOY_EXTRA_ARGS:-}" ]]; then
  read -ra extra <<< "$DEPLOY_EXTRA_ARGS"
  args+=("${extra[@]}")
fi

echo "-> Running server deploy from $BUILD_DIR"
exec bash scripts/deploy-server.sh "${args[@]}"
REMOTE
)"

log "Starting production deploy through $FOT_SSH"
ssh "$FOT_SSH" "${remote_env[*]} bash -s" <<< "$remote_script"
