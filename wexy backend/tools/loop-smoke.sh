#!/usr/bin/env bash
# E1 (forge-loop design §12): the loop end to end, across processes, with no key and no spend. A plan,
# the three functions at once, a repair of evolve with one finding, a direct turn and the browser's
# outcome report, through the real gateway and service, with the mock upstream behind them and Redis
# metering every call. Every stream's event order is checked (one meta first, deltas, one usage, then
# exactly one done; no error), the direct answer and the outcome's status are checked, and the
# timings are printed.
#
#   docker compose -f compose.local.yaml up -d
#   ./mvnw -pl forge-gateway spring-boot:run -Dspring-boot.run.profiles=local
#   ./mvnw -pl forge-service spring-boot:run -Dspring-boot.run.profiles=local,mock
#   bash tools/loop-smoke.sh ["an idea"]
#
# It signs in with a local dev token (design §9), so the gateway must run under the local profile with no
# Firebase credentials. Since W1 the gateway counts prompts as a deployment does, so the smoke signs in as its
# local operator (dev.google.<uid>, on the local profile's admin list: twenty plans a day), not as a new anonymous
# caller, whose network's one anonymous plan a day the first run would spend. WEXY_SMOKE_TOKEN overrides it.
# The streams land in out/smoke/<time>/ (git-ignored). Exit 0 when every check passes, 1 on a failed check, 2 when
# a service is not up.
set -u
cd "$(dirname "$0")/.." || exit 2

GATEWAY=${WEXY_GATEWAY:-http://localhost:8400}
SERVICE=${WEXY_SERVICE:-http://localhost:8410}
IDEA=${1:-"a spiral galaxy, gold at the core and blue along the arms"}
TOKEN=${WEXY_SMOKE_TOKEN:-dev.google.00000000000000000000000000000001}
OUT="out/smoke/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" || exit 2
status=0
started=$(date +%s%3N)

# Health is 503 while the meter is down (gotchas), so 200 from both means Redis is up as well.
health() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1/actuator/health"; }
code=$(health "$GATEWAY")
[ "$code" = 200 ] || { echo "the gateway at $GATEWAY answers $code to /actuator/health: start it under the local profile, with Redis up"; exit 2; }
code=$(health "$SERVICE")
[ "$code" = 200 ] || { echo "the service at $SERVICE answers $code to /actuator/health: start it under local,mock, with Redis up"; exit 2; }
curl -sf --max-time 5 "$GATEWAY/.well-known/jwks.json" >/dev/null || { echo "the gateway publishes no key set at $GATEWAY/.well-known/jwks.json"; exit 2; }

# The text as a JSON string literal: quotes and backslashes escaped (an idea has no control characters).
json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# call <name> <path> <body> [ext]: one request, into $OUT/<name>.sse (or .json), .headers and .meta
# (status, first byte, total).
call() {
    local name=$1 path=$2 body=$3 ext=${4:-sse}
    curl -sS -N --max-time 120 -X POST "$GATEWAY$path" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: text/event-stream, application/json" \
        -d "$body" -D "$OUT/$name.headers" -o "$OUT/$name.$ext" \
        -w '%{http_code} %{time_starttransfer} %{time_total}' > "$OUT/$name.meta" 2> "$OUT/$name.err"
}

ms() { awk "BEGIN { printf \"%d\", $1 * 1000 }"; }

# check <name> <label>: the status, the content type and the event order of one stream; one report line.
check() {
    local name=$1 label=$2
    local http first total
    read -r http first total < "$OUT/$name.meta"
    local summary
    summary=$(tr -d '\r' < "$OUT/$name.sse" | awk '
        /^:/ { hb++; next }
        /^event:/ { n = $0; sub(/^event:[ \t]*/, "", n); events++
                    if (first == "") first = n; prev = last; last = n
                    if (n == "meta") meta++; else if (n == "delta") delta++; else if (n == "usage") usage++
                    else if (n == "done") done++; else if (n == "error") error++ }
        END { printf "%s %s %s %d %d %d %d %d %d %d", (first == "" ? "-" : first), (prev == "" ? "-" : prev),
              (last == "" ? "-" : last), meta + 0, delta + 0, usage + 0, done + 0, error + 0, hb + 0, events + 0 }')
    local first_ev prev_ev last_ev meta delta usage done error hb events
    read -r first_ev prev_ev last_ev meta delta usage done error hb events <<<"$summary"
    local problems=""
    [ "$http" = 200 ] || problems="$problems HTTP $http $(head -c 200 "$OUT/$name.sse" | tr -d '\r\n');"
    grep -qi '^content-type: *text/event-stream' "$OUT/$name.headers" || problems="$problems not text/event-stream;"
    { [ "$first_ev" = meta ] && [ "$meta" = 1 ]; } || problems="$problems meta not first and once;"
    [ "$delta" -ge 1 ] || problems="$problems no delta;"
    { [ "$usage" = 1 ] && [ "$prev_ev" = usage ]; } || problems="$problems usage not once, right before the end;"
    { [ "$done" = 1 ] && [ "$last_ev" = done ]; } || problems="$problems done not last and once;"
    [ "$error" = 0 ] || problems="$problems error event: $(tr -d '\r' < "$OUT/$name.sse" | grep -A1 '^event:[ \t]*error' | grep '^data:' | head -1 | cut -c1-160);"
    if [ -z "$problems" ]; then
        printf 'ok       %-14s meta 1 · delta %-4d · usage 1 · done 1 · hb %-2d  first byte %5d ms  total %6d ms\n' \
            "$label" "$delta" "$hb" "$(ms "$first")" "$(ms "$total")"
    else
        printf 'FAIL     %-14s%s  (events: %s)\n' "$label" "$problems" "$events"
        status=1
    fi
}

# check_json <name> <label> <status> <pattern>: a JSON answer's status, content type and one expected fragment.
check_json() {
    local name=$1 label=$2 expected=$3 pattern=$4
    local http first total
    read -r http first total < "$OUT/$name.meta"
    local problems=""
    [ "$http" = "$expected" ] || problems="$problems HTTP $http, not $expected: $(head -c 200 "$OUT/$name.json" | tr -d '\r\n');"
    grep -qi '^content-type: *application/json' "$OUT/$name.headers" || problems="$problems not application/json;"
    grep -q -- "$pattern" "$OUT/$name.json" || problems="$problems no $pattern in the answer;"
    if [ -z "$problems" ]; then
        printf 'ok       %-14s HTTP %s · %-32s                first byte %5d ms  total %6d ms\n' \
            "$label" "$http" "$pattern" "$(ms "$first")" "$(ms "$total")"
    else
        printf 'FAIL     %-14s%s\n' "$label" "$problems"
        status=1
    fi
}

generation_id() {
    tr -d '\r' < "$OUT/$1.sse" | grep -A1 '^event:[ \t]*meta' | grep '^data:' | head -1 | sed -E 's/.*"generationId":"([^"]+)".*/\1/'
}

echo "Wexy loop smoke: $GATEWAY, then $SERVICE; as $TOKEN (a local dev token, not a secret); idea: $IDEA"
echo "streams: $OUT"

# 1. The plan.
call plan /v1/forge/plan "{\"prompt\":$(json_string "$IDEA"),\"style\":\"cosmic\",\"seconds\":12}"
check plan plan
PLAN_ID=$(generation_id plan)
if [ "$status" != 0 ] || [ -z "$PLAN_ID" ]; then
    echo "FAIL     no usable plan, so the functions were not asked for; see $OUT"
    exit 1
fi

# 2. The three functions at once, as the studio asks for them.
for fn in evolve look sky; do
    call "author.$fn" /v1/forge/author "{\"planId\":\"$PLAN_ID\",\"fn\":\"$fn\"}" &
done
wait
for fn in evolve look sky; do
    check "author.$fn" "author $fn"
done
EVOLVE_ID=$(generation_id author.evolve)

# 3. A repair of evolve with one finding, as the browser's gate would report it (the mock answers the exemplar).
REPAIR_ID=""
if [ -n "$EVOLVE_ID" ]; then
    call repair /v1/forge/repair "{\"generationId\":\"$EVOLVE_ID\",\"diagnostics\":[{\"source\":\"tint\",\"line\":11,\"column\":25,\"message\":\"type mismatch for argument 1 in call to 'hash11', expected 'f32', got 'u32'\",\"snippet\":\"let jitter = hash11(i) * 0.02;\"}]}"
    check repair repair
    REPAIR_ID=$(generation_id repair)
else
    echo "FAIL     no evolve generation, so no repair was asked for"
    status=1
fi

# 4. A direct turn about a running world (a small spec stands in for the studio's; the mock's director
#    answers its recorded edit whatever the world), and the answer is one JSON document. It names its plan, so it
#    runs inside the plan's prompt (W1): without planId it would be a second anonymous prompt, refused 403.
SPEC='{"title":"Smoke world","summary":"A world the smoke script runs.","uniforms":{"spin":{"label":"Spin speed","value":1,"min":0,"max":2}},"post":{"bloom":{"intensity":0.6}},"camera":{"move":"orbit"}}'
call direct /v1/forge/direct "{\"spec\":$SPEC,\"turn\":\"make it glow more\",\"planId\":\"$PLAN_ID\"}" json
check_json direct direct 200 '"kind":"patch"'

# 5. The browser's outcome report about every generation above.
IDS="\"$PLAN_ID\",\"$EVOLVE_ID\",\"$(generation_id author.look)\",\"$(generation_id author.sky)\""
[ -n "$REPAIR_ID" ] && IDS="$IDS,\"$REPAIR_ID\""
call outcomes /v1/forge/outcomes "{\"generationIds\":[$IDS],\"ladder\":{\"L0\":{\"ok\":true,\"ms\":0.4},\"L3\":{\"ok\":true,\"ms\":2.1}},\"firstPassOk\":true,\"repairs\":1,\"autofixes\":0,\"probeMs\":12.5,\"predictedMs\":8.0,\"fps\":60,\"adapter\":\"smoke\",\"browser\":\"curl\"}" json
check_json outcomes outcomes 202 '{}'

elapsed=$(( $(date +%s%3N) - started ))
if [ "$status" = 0 ]; then
    echo "PASS     7 calls through the gateway, the service, the mock and Redis in $elapsed ms; plan $PLAN_ID"
else
    echo "FAIL     see $OUT"
fi
exit $status
