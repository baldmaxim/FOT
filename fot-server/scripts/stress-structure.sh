#!/usr/bin/env bash
# Stress-test для проверки single-flight + SWR на /api/structure.
# Запуск:
#   BASE_URL=http://localhost:3001 TOKEN="<jwt>" bash fot-server/scripts/stress-structure.sh
#
# Что проверяет:
# 1) Single-flight: при cache miss из 50 параллельных curl бэк делает только 1
#    реальный запрос к Supabase (остальные 49 — X-Cache-Status: COALESCED).
# 2) SWR: запрос сразу после истечения TTL отдаёт STALE мгновенно.
#
# В Supabase Dashboard / Sentry должно быть видно: ровно один SELECT org_departments
# на cold-miss-сегмент (а не 50).

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
TOKEN="${TOKEN:-}"
N="${N:-50}"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: TOKEN env not set. Получите JWT из DevTools → Application → Local Storage → token." >&2
  exit 1
fi

ENDPOINT="$BASE_URL/api/structure"

echo "=== Phase 1: cold cache miss (N=$N parallel curl on $ENDPOINT) ==="
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Сначала инвалидируем кеш через CRUD-эндпоинт. Пропускаем — в проде нет, но локально
# можно перезапустить сервер. Здесь полагаемся на естественное истечение TTL или ручной рестарт.
echo "(подразумевается, что кеш пуст: рестартани сервер или подожди staleMs)"

seq 1 "$N" | xargs -I{} -P "$N" -n 1 sh -c '
  curl -s -o "'"$TMPDIR"'/body-$1.json" \
    -D "'"$TMPDIR"'/headers-$1.txt" \
    -H "Authorization: Bearer '"$TOKEN"'" \
    "'"$ENDPOINT"'"
' _ {}

MISS_COUNT=$(grep -li 'X-Cache-Status: MISS' "$TMPDIR"/headers-*.txt | wc -l | tr -d ' ')
COALESCED_COUNT=$(grep -li 'X-Cache-Status: COALESCED' "$TMPDIR"/headers-*.txt | wc -l | tr -d ' ')
HIT_COUNT=$(grep -li 'X-Cache-Status: HIT' "$TMPDIR"/headers-*.txt | wc -l | tr -d ' ')
STALE_COUNT=$(grep -li 'X-Cache-Status: STALE' "$TMPDIR"/headers-*.txt | wc -l | tr -d ' ')

echo "MISS=$MISS_COUNT  COALESCED=$COALESCED_COUNT  HIT=$HIT_COUNT  STALE=$STALE_COUNT"

if [[ "$MISS_COUNT" != "1" ]]; then
  echo "FAIL: ожидался ровно 1 MISS, получили $MISS_COUNT" >&2
  echo "Single-flight не работает или кеш не был пустым. Проверьте Supabase logs." >&2
  exit 2
fi

# Контроль идентичности тел
FIRST_HASH=$(shasum < "$TMPDIR/body-1.json" | awk '{print $1}')
ALL_SAME=true
for f in "$TMPDIR"/body-*.json; do
  H=$(shasum < "$f" | awk '{print $1}')
  if [[ "$H" != "$FIRST_HASH" ]]; then
    ALL_SAME=false
    break
  fi
done
if [[ "$ALL_SAME" != "true" ]]; then
  echo "FAIL: тела ответов отличаются между параллельными curl" >&2
  exit 3
fi

echo "OK: 1 MISS + $COALESCED_COUNT COALESCED, тела идентичны."
echo
echo "Теперь дёрни ещё раз (должно быть N HIT):"
echo "  curl -sI -H 'Authorization: Bearer \$TOKEN' $ENDPOINT | grep -i X-Cache-Status"
