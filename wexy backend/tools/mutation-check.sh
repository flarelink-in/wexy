#!/usr/bin/env bash
# Breaks one protection at a time and checks that the test meant to guard it fails (coding
# principles §13: a test that has never failed may assert nothing). Each source file is restored
# afterwards and checked by hash, also when the run is interrupted. About 8 minutes.
#
#   export MAVEN_OPTS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'
#   bash tools/mutation-check.sh
#
# Output: CAUGHT (the test failed, as it must), SURVIVED (it still passed: the test is too weak),
# or SKIP (the mutation no longer matches the code: update it). Exit 1 if any survived or skipped.
set -u
cd "$(dirname "$0")/.." || exit 2

G=forge-gateway/src/main/java/ai/wexy/gateway
S=forge-service/src/main/java/ai/wexy/forge
BACKUP=$(mktemp)
CURRENT=""
status=0

restore() {
    if [ -n "$CURRENT" ]; then
        cp "$BACKUP" "$CURRENT"
        CURRENT=""
    fi
}
trap 'restore; rm -f "$BACKUP"' EXIT
trap 'echo "interrupted: restoring"; exit 130' INT TERM

mutate() { # name file module test perl-expression
    local name=$1 file=$2 module=$3 test=$4 expr=$5
    local before
    before=$(sha256sum "$file" | cut -d' ' -f1)
    cp "$file" "$BACKUP"
    CURRENT=$file
    perl -0pi -e "$expr" "$file"
    if [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$before" ]; then
        echo "SKIP     $name: the mutation no longer matches $file"
        status=1
    elif ./mvnw -B -q -pl "$module" -am test -Dtest="$test" -Dsurefire.failIfNoSpecifiedTests=false >/dev/null 2>&1; then
        echo "SURVIVED $name: $test still passes"
        status=1
    else
        echo "CAUGHT   $name: $test failed"
    fi
    restore
    [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$before" ] || { echo "!! could not restore $file"; exit 3; }
}

mutate "charge skipped" "$S/upstream/MeteredModelClient.java" forge-service MeteredModelClientTest \
    's/switch \(receipt\.outcome\(\)\) \{/switch (SpendGuard.Charge.ALLOWED) {/'
mutate "missing cap allowed" "$S/spend/SpendGuard.java" forge-service SpendGuardTest \
    's/if \(cap == null \|\| cap\.monthlyMicroUsd\(\) == null \|\| cap\.dailyMicroUsd\(\) == null\) \{/if (false) {/'
mutate "key not scrubbed" "$S/upstream/MetaApiClient.java" forge-service MetaApiClientTest \
    's/String clean = properties\.hasKey\(\) \? text\.replace\(properties\.apiKey\(\), "<key>"\) : text;/String clean = text;/'
mutate "handler errors become 401" "$S/identity/InternalTokenFilter.java" forge-service InternalTokenFilterTest \
    's/(\s*\.onErrorMap\(error -> !\(error instanceof ForgeException\),\s*error -> new ForgeException\(ErrorCode\.AUTH, "The internal token is not valid\."\)\))(\s*\.flatMap\(caller -> \{.*?\n\s*\}\));/$2$1;/s'
mutate "client identity not stripped" "$G/shield/EdgeShieldFilter.java" forge-gateway GatewayEndToEndTest \
    's/ServerWebExchange sanitised = stripSpoofableHeaders\(exchange\);/ServerWebExchange sanitised = exchange;/'
mutate "anonymous takes account action" "$G/auth/AuthorizationFilter.java" forge-gateway AuthorizationFilterTest \
    's/if \(policy == Policy\.ACCOUNT_REQUIRED && caller\.anonymous\(\)\) \{/if (false) {/'
mutate "author spends App Check" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/\.filter\(appCheck\)\n/.filter(appCheck.singleUse())\n/'
# B0.2 (forge-loop design §12, M2): the loop's own protections. "charge skipped" above now guards charge().
mutate "plan schema not checked" "$S/loop/LoopHandler.java" forge-service LoopRoutesTest \
    's/new ArrayList<>\(schemas\.validate\(schema, answer\)\)/new ArrayList<String>()/'
mutate "another caller's plan served" "$S/loop/LoopHandler.java" forge-service LoopRoutesTest \
    's/\.filter\(g -> g\.uid\(\)\.equals\(caller\.uid\(\)\)\)/.filter(g -> true)/'
mutate "denied call not recorded" "$S/loop/LoopHandler.java" forge-service LoopRoutesTest \
    's/store\.finish\(g\.id\(\), new Generation\.Finish\(null, null, null, null, 0, null, null, null, Generation\.Status\.DENIED\)\);//'

# B0.3 (forge-loop design §12, M4): dev tokens must not exist outside the local profile.
mutate "dev tokens outside local" "$G/auth/DevTokenVerifier.java" forge-gateway DevTokenVerifierProfileTest \
    's/@Profile\("local"\)\n//'

# B0.4 (forge-loop design §12, M3): the repair depth, and the escalation that comes with it.
mutate "fourth repair allowed" "$S/loop/LoopHandler.java" forge-service RepairDirectOutcomesTest \
    's/if \(depth >= MAX_REPAIRS\) \{/if (false) {/'
mutate "repairs never escalate" "$S/loop/LoopHandler.java" forge-service RepairDirectOutcomesTest \
    's/String role = depth < MAX_REPAIRS - 1 \? "repairer" : "escalator";/String role = "repairer";/'
mutate "another caller's function repaired" "$S/loop/LoopHandler.java" forge-service RepairDirectOutcomesTest \
    's/(\.filter\(g -> g\.status\(\) == Generation\.Status\.OK\)\n\s*)\.filter\(g -> g\.uid\(\)\.equals\(caller\.uid\(\)\)\)\n(\s*\.orElseThrow\(LoopHandler::unknownWorld\);\n\s*int depth)/$1$2/'
mutate "edit plan not validated" "$S/loop/LoopHandler.java" forge-service RepairDirectOutcomesTest \
    's/if \(!problems\.isEmpty\(\)\) \{\n(\s*return unusable\(call, "invalid")/if (false) {\n$1/'

# The review of 2026-10-27 (forge-loop design, Results): the record and the meter stay honest.
mutate "settlement skipped" "$S/upstream/MeteredModelClient.java" forge-service LoopLifecycleTest \
    's/spendGuard\.settle\(receipt, cost, detail\)/SpendGuard.Settlement.NONE/'
mutate "debt ignored" "$S/spend/SpendGuard.java" forge-service SpendGuardSettlementTest \
    's/if \(!settleDebts\(\)\) \{/if (false) {/'
mutate "meter failure after a cancel unreported" "$S/upstream/MeteredModelClient.java" forge-service LoopLifecycleTest \
    's/tellFailed\(listener, e, detail\);//'
mutate "cancel during the charge ignored" "$S/loop/LoopHandler.java" forge-service LoopLifecycleTest \
    's/\n\s*\.doOnCancel\(call::cancelled\);/;/g'
mutate "charge listener silenced" "$S/upstream/MeteredModelClient.java" forge-service MeteredModelClientTest \
    's/tell\(listener, new Reservation\(receipt\.outcome\(\), bound, inputTokens\), detail\);//'
mutate "empty function accepted" "$S/loop/LoopHandler.java" forge-service LoopLifecycleTest \
    's/if \(function\.isBlank\(\)\) \{/if (false) {/'

# F7 of the frontend's pass-graph design (2026-10-29): a usage without whole token counts is no usage.
mutate "an empty usage counted as zero" "$S/upstream/MetaApiClient.java" forge-service MetaApiClientTest \
    's/tokens\(usage\.path\("(prompt|completion)_tokens"\)\)/usage.path("$1_tokens").asLong()/g'

exit $status
