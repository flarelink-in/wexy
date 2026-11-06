#!/usr/bin/env bash
# Breaks one protection at a time and checks that the test meant to guard it fails (coding
# principles §13: a test that has never failed may assert nothing). Each source file is restored
# afterwards and checked by hash, also when the run is interrupted. About 25 minutes for all.
#
#   export MAVEN_OPTS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'
#   bash tools/mutation-check.sh
#   MUTATION_ONLY='agent|tool' bash tools/mutation-check.sh   # only the mutations whose name matches
#   MUTATION_RANGE=23-40 bash tools/mutation-check.sh         # only the 23rd to the 40th, in this file's order
#   MUTATION_DRY_RUN=1 bash tools/mutation-check.sh           # each must still change its file; no Maven
#
# Output: CAUGHT (the test failed, as it must), SURVIVED (it still passed: the test is too weak),
# BROKEN (the mutation does not compile, so the test never ran: rewrite the mutation), ERROR (Maven
# failed before the test ran), or SKIP (the mutation no longer matches the code: update it); with
# MUTATION_DRY_RUN, MATCHES or SKIP. Exit 1 if any mutation is not CAUGHT (or MATCHES).
# First, a preflight reads every entry, whatever MUTATION_ONLY or MUTATION_RANGE select: an entry whose file
# or test class does not exist is MISSING, and the run stops with exit 2 before anything is mutated. Maven runs
# with -Dsurefire.failIfNoSpecifiedTests=false (for the modules -am builds), so a deleted test would run nothing
# and pass, and its mutation would read as SURVIVED (EA9.6's outside review, 2026-11-06). The test is a class
# name in the module's src/test/java, or several separated by commas; a #method is allowed.
# In a Perl pattern, escape @ and $ (\@Profile): unescaped, Perl interpolates them as variables.
set -u
cd "$(dirname "$0")/.." || exit 2

G=forge-gateway/src/main/java/ai/wexy/gateway
S=forge-service/src/main/java/ai/wexy/forge
R=forge-service/src/main/resources
BACKUP=$(mktemp)
LOG=$(mktemp)
CURRENT=""
ONLY=${MUTATION_ONLY:-}
RANGE=${MUTATION_RANGE:-}
DRY=${MUTATION_DRY_RUN:-}
PREFLIGHT=""
status=0
ran=0
index=0
missing=0
# Every test class of every module, one "module Class" a line, for the preflight.
TEST_CLASSES=$'\n'$(find . -path '*/target' -prune -o -path './*/src/test/java/*' -name '*.java' -print \
    | sed -E 's#^\./([^/]+)/.*/([^/]+)\.java$#\1 \2#')$'\n'

restore() {
    if [ -n "$CURRENT" ]; then
        cp "$BACKUP" "$CURRENT"
        CURRENT=""
    fi
}
trap 'restore; rm -f "$BACKUP" "$LOG"' EXIT
trap 'echo "interrupted: restoring"; exit 130' INT TERM

mutate() { # name file module test perl-expression
    local name=$1 file=$2 module=$3 test=$4 expr=$5
    local before class
    if [ -n "$PREFLIGHT" ]; then
        if [ ! -f "$file" ]; then
            echo "MISSING  $name: no file $file"
            missing=$((missing + 1))
        fi
        for class in ${test//,/ }; do
            class=${class%%#*}
            case $TEST_CLASSES in
                *$'\n'"$module $class"$'\n'*) ;;
                *) echo "MISSING  $name: no test class $class in $module/src/test/java"
                   missing=$((missing + 1)) ;;
            esac
        done
        return
    fi
    index=$((index + 1))
    if [ -n "$RANGE" ] && { [ "$index" -lt "${RANGE%-*}" ] || [ "$index" -gt "${RANGE#*-}" ]; }; then
        return
    fi
    if [ -n "$ONLY" ] && ! printf '%s' "$name" | grep -Eq -- "$ONLY"; then
        return
    fi
    ran=$((ran + 1))
    before=$(sha256sum "$file" | cut -d' ' -f1)
    cp "$file" "$BACKUP"
    CURRENT=$file
    perl -0pi -e "$expr" "$file"
    if [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$before" ]; then
        echo "SKIP     $name: the mutation no longer matches $file"
        status=1
    elif [ -n "$DRY" ]; then
        echo "MATCHES  $name"
    elif ./mvnw -B -q -pl "$module" -am test -Dtest="$test" -Dsurefire.failIfNoSpecifiedTests=false >"$LOG" 2>&1; then
        echo "SURVIVED $name: $test still passes"
        status=1
    elif grep -q "COMPILATION ERROR" "$LOG"; then
        echo "BROKEN   $name: it does not compile, so $test never ran (rewrite the mutation)"
        status=1
    elif grep -Eq "There are test failures|Failures: [1-9]|Errors: [1-9]" "$LOG"; then
        echo "CAUGHT   $name: $test failed"
    else
        echo "ERROR    $name: Maven failed before $test ran:"
        tail -n 5 "$LOG" | sed 's/^/         /'
        status=1
    fi
    restore
    [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$before" ] || { echo "!! could not restore $file"; exit 3; }
}

# The list, read twice: once by the preflight, then to mutate.
mutations() {
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
# A read that takes the cached App Check token spends none. This was "author spends App Check" until EA9.6 retired h1's
# author route (2026-11-06); its unanchored pattern then matched the review terms' read, so each read is named now.
mutate "the review terms' read spending App Check" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.filter\(rateLimits\.byClient\("review-read"\)\)\n\s*)\.filter\(appCheck\)\n/$1.filter(appCheck.singleUse())\n/'
mutate "the allowance read spending App Check" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.filter\(rateLimits\.byClient\("account-read"\)\)\n\s*)\.filter\(appCheck\)\n/$1.filter(appCheck.singleUse())\n/'
# B0.2 and B0.4 (forge-loop design §12, M2, M3): h1's loop and its repair depth. Their mutations went with h1's routes at
# EA9.6 (2026-11-06); "charge skipped" above guards charge().

# B0.3 (forge-loop design §12, M4): dev tokens must not exist outside the local profile. The @ is
# escaped since 2026-10-31: unescaped, Perl read it as an empty array and the mutation left a bare
# @Profile, which does not compile, so this was "caught" without the profile test ever running.
mutate "dev tokens outside local" "$G/auth/DevTokenVerifier.java" forge-gateway DevTokenVerifierProfileTest \
    's/\@Profile\("local"\)\n//'

# The review of 2026-10-27 (forge-loop design, Results): the record and the meter stay honest. Since EA9.6 the meter's
# half is held by MeteredModelClientTest, as h1's LoopLifecycleTest held it through the plan route: a call settled to its
# usage once, and the meter's own failure after a cancel told to its listener.
mutate "settlement skipped" "$S/upstream/MeteredModelClient.java" forge-service MeteredModelClientTest \
    's/spendGuard\.settle\(receipt, cost, detail\)/SpendGuard.Settlement.NONE/'
mutate "debt ignored" "$S/spend/SpendGuard.java" forge-service SpendGuardSettlementTest \
    's/if \(!settleDebts\(\)\) \{/if (false) {/'
mutate "meter failure after a cancel unreported" "$S/upstream/MeteredModelClient.java" forge-service MeteredModelClientTest \
    's/tellFailed\(listener, e, detail\);//'
mutate "charge listener silenced" "$S/upstream/MeteredModelClient.java" forge-service MeteredModelClientTest \
    's/tell\(listener, new Reservation\(receipt\.outcome\(\), bound, inputTokens\), detail\);//'

# F7 of the frontend's pass-graph design (2026-10-29): a usage without whole token counts is no usage.
mutate "an empty usage counted as zero" "$S/upstream/MetaApiClient.java" forge-service MetaApiClientTest \
    's/tokens\(usage\.path\("(prompt|completion)_tokens"\)\)/usage.path("$1_tokens").asLong()/g'

# The agent path (the agent-loop design: EA2.1 to EA2.5 and gate A; the frontend's engine-adapters
# design: EA3.6). Each was first broken by hand when its step was built, and caught; added here on
# 2026-10-31.
# EA2.1: the documentation tools' caps.
mutate "a tool round past its cap" "$S/agent/AgentTools.java" forge-service AgentToolsTest \
    's/if \(i == budget\.perRound\(\)\) \{/if (false) {/; s/\} else if \(i > budget\.perRound\(\)\) \{/} else if (false) {/'
mutate "tool requests past the turn's cap" "$S/agent/AgentTools.java" forge-service AgentToolsTest \
    's/\} else if \(budget\.requestsLeft\(\) <= 0\) \{/} else if (false) {/'
mutate "a cut block not counted" "$S/agent/AgentTools.java" forge-service AgentToolsTest \
    's/(int n = bytes\(text\);)\n\s*budget\.spend\(n\);/$1/'
mutate "a read one line too long" "$S/agent/AgentTools.java" forge-service AgentToolsTest \
    's/int end = Math\.min\(all\.length, start \+ count - 1\);/int end = Math.min(all.length, start + count);/'
mutate "a tool that imports the file system" "$S/agent/AgentTools.java" forge-service AgentToolsTest \
    's/import java\.nio\.charset\.StandardCharsets;/import java.nio.charset.StandardCharsets;\nimport java.nio.file.Files;/'
# EA2.3 and gate A: the turn's budgets, each checked before a call, and its deadline after one.
mutate "a turn's calls unbounded" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(calls >= budget\.calls\(\)\) \{/if (false) {/'
mutate "a turn's money unchecked" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(spent \+ bound > budget\.turnMicroUsd\(\)\) \{/if (false) {/'
mutate "a turn's time unchecked before a call" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(clockMillis\.getAsLong\(\) - started >= budget\.turnSeconds\(\) \* 1000\) \{(\n\s*return "EA_TURN_BUDGET)/if (false) {$1/'
mutate "an answer after the deadline acted on" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(clockMillis\.getAsLong\(\) - started >= budget\.turnSeconds\(\) \* 1000\) \{(\n\s*\/\/ The turn)/if (false) {$1/'
mutate "a prompt over its budget sent" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(bytes > budget\.promptBytes\(\)\) \{/if (false) {/'
mutate "revisions unbounded" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(revisions >= budget\.revisions\(\)\) \{/if (false) {/'
mutate "schema repairs unbounded" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(repairs >= budget\.schemaRepairs\(\)\) \{/if (false) {/'
mutate "earlier answers dropped from the next call" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/\n\s*messages\.add\(ChatMessage\.assistant\(answer\.text\(\)\)\);//'
mutate "a refused first call reported as a failure" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/boolean denied = n == 1 && \("budget"\.equals\(f\.code\(\)\) \|\| "paused"\.equals\(f\.code\(\)\)\);/boolean denied = false;/'
mutate "the wire-size finding's path not a pointer" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's#Finding\.fail\("wire-size", "/" \+ name,#Finding.fail("wire-size", name,#'
# EA2.4 and gate A: the route, its records, and the meter's one door.
mutate "a client leaving before the headers not cancelling the turn" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/\n\s*calls\.cancel\(\);(\n\s*\}\)\.flatMap\(started)/$1/'
mutate "a client leaving mid-call not cancelling it" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/\n\s*calls\.cancel\(\);(\n\s*\}\), loopProperties\.heartbeat\(\))/$1/'
mutate "stray request fields allowed" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/if \(!extra\.isEmpty\(\)\) \{/if (false) {/'
mutate "a denial answered 500" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/if \(outcome\.status\(\) == AgentOutcome\.Status\.DENIED\) \{/if (false) {/'
mutate "meta names no adapter manifest" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/\n\s*meta\.put\("manifestHash", AdapterManifest\.HASH\);//'
mutate "a refused charge recorded as an error" "$S/agent/MeteredModelCaller.java" forge-service AgentRoutesTest \
    's/refused \? Generation\.Status\.DENIED : Generation\.Status\.ERROR/Generation.Status.ERROR/'
mutate "the call event never sent" "$S/agent/MeteredModelCaller.java" forge-service AgentRoutesTest \
    's/\n\s*charged\.run\(\);//'
# EA2.5: the wire both repositories read, compared with its recordings.
mutate "the check event's findings renamed" "$S/agent/AgentLoop.java" forge-service AgentWireTest \
    's/"findings", listed/"diagnostics", listed/'
# EA3.6: the program check on adapter nodes (the frontend's checkNodes, in Java) and the v2 schema.
# Re-aimed on 2026-11-06: since EA9.4's review the mapper is a JsonMapper builder (with duplicate keys refused), which the
# old pattern no longer matched.
mutate "trailing text after a config read as JSON" "$S/agent/NodeCheck.java" forge-service NodeCheckTest \
    's/\.enable\(DeserializationFeature\.FAIL_ON_TRAILING_TOKENS\)\.build\(\)/.build()/'
mutate "a stage's writes not filling a drawn buffer" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/&& !written\.contains\(n\.id\(\)\)//'
mutate "every zeroed buffer to be filled, drawn or not" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(drawn\.contains\(n\.id\(\)\) && !"upload"/if (!"upload"/'
mutate "work at init counted as motion" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(phase\.equals\("fixedStep"\) \|\| phase\.equals\("frame"\)\)/if (!phase.isEmpty())/'
mutate "an authored draw not moving" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/\|\| nodes\.stream\(\)\.anyMatch\(n -> AUTHORED_DRAWS\.contains\(n\.adapter\(\)\.id\(\)\)\)//'
mutate "motion of a buffer nothing draws counted" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/drawn\.stream\(\)\.anyMatch\(moved::contains\)/!moved.isEmpty()/'
mutate "a custom batch's vertex entry unchecked" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/List\.of\("vertexEntry", "fragmentEntry"\)/List.of("fragmentEntry")/'
mutate "whole-program rules run while nodes fail" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(checked\.findings\(\)\.isEmpty\(\)\) \{/if (true) {/'
mutate "an external family in the design only warned" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/out\.add\(Finding\.fail\("external"/out.add(Finding.warn("external"/'
mutate "the action schema dropping an adapter" "$R/schemas/agent-action.v3.json" forge-service ProgramCheckTest \
    's/"ng\.render\.fullscreen",\n\s*"ng\.post\.chain"\n/"ng.render.fullscreen"\n/'
# Gate A, in the gateway: the agent route spends its App Check token, and its buckets charge a turn
# its possible calls.
mutate "the agent turn spending no App Check" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.filter\(rateLimits\.byClient\("agent-turn"\)\)\n\s*)\.filter\(appCheck\.singleUse\(\)\)/$1.filter(appCheck)/'
mutate "an agent bucket of another cost accepted" "$G/shield/GatewayShieldProperties.java" forge-gateway ForgeRoutesTest \
    's/if \(name\.startsWith\("agent-turn"\) && bucket\.getRequestCost\(\) != AgentTurn\.MAX_CALLS\) \{/if (false) {/'

# EA4.2 (the frontend's candidate-loop design §5, §6; added 2026-10-31, each first broken by hand when built, and
# caught): Q80's variant gate, and the module route's checks before any charge, its judged answer and its prompt.
mutate "a gated value accepted by the node check" "$S/agent/NodeCheck.java" forge-service NodeCheckTest \
    's/if \(g\.adapter\(\)\.equals\(adapter\.id\(\)\) && g\.value\(\)\.equals\(config\.at\(g\.path\(\)\)\)\) \{/if (false) {/'
mutate "the manifest reading no gate" "$S/engine/AdapterManifest.java" forge-service AdapterManifestTest \
    's/gates\(m\.path\("unavailable"\), adapters, name\)/List.of()/'
mutate "a module call on another caller's turn" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/if \(!owned\) \{/if (false) {/'
mutate "a module request of another build" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/if \(!pin\.getValue\(\)\.equals\(versions\.path\(pin\.getKey\(\)\)\.asText\(null\)\)\) \{/if (false) {/'
mutate "a module slice's nodes unchecked" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/if \(!alone\.findings\(\)\.isEmpty\(\)\) \{/if (false) {/'
mutate "two owners of one module" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/if \(owners\.size\(\) != 1\) \{/if (owners.isEmpty()) {/'
mutate "a repair whose body is not its hash's" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/if \(codeHash == null \|\| !codeHash\.equals\(sha256\(body\)\)\) \{/if (codeHash == null) {/'
mutate "a module answer without its entry done" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/if \(!defines\(body, entry\)\) \{/if (false) {/'
mutate "an oversized module answer done" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/if \(body\.length\(\) > ModuleRequest\.MAX_BODY_CHARS\) \{/if (false) {/'
mutate "a module prompt without the request" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/put\("prompt", m\.request\(\)\.prompt\(\)\)/put("prompt", "")/'
mutate "a fence the client's backticks can close" "$S/templates/PromptBuilder.java" forge-service PromptBuilderTest \
    's/Math\.max\(3, longest \+ 1\)/3/'
# The EA4.2 review (2026-10-31): the interface's projection checked element by element, its signatures one line and
# quoted as data, custom lighting gated by its wire and by its chunk, and an entry found as tokens outside comments.
mutate "an entry of any stage" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest     's/if \(!owner\.stages\(\)\.get\(i\)\.equals\(stage\)\) \{/if (false) {/'
mutate "a signature that can carry instructions" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest     's/ \|\| !SIGNATURE_TAIL\.matcher\(signature\.substring\(3 \+ entry\.length\(\)\)\)\.matches\(\)//'
mutate "a binding of any access" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest     's/ \|\| !oneOf\(b\.path\("access"\), "read", "read_write", "uniform"\)//'
mutate "a custom batch wired to lights authored" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest     's/if \(own\.inputs\(\)\.stream\(\)\.anyMatch/if (false \&\& own.inputs().stream().anyMatch/'
mutate "the lighting chunk authored" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest     's/if \(c\.path\("id"\)\.asText\(\)\.startsWith\(LIGHTS_CHUNK\)\) \{/if (false) {/'
mutate "an entry found in a comment" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest     's/\.matcher\(uncommented\(body\)\)/.matcher(body)/'
mutate "a signature in backticks" "$S/templates/PromptBuilder.java" forge-service ModuleRoutesTest     's/"- " \+ quoted\(s\)/"- `" + s + "`"/'
mutate "the module route spending no App Check" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.filter\(rateLimits\.byClient\("agent-module"\)\)\n\s*)\.filter\(appCheck\.singleUse\(\)\)/$1.filter(appCheck)/'
# EA4.4 (2026-11-01; the frontend's candidate-loop design §8, Q82 (a)): a turn that revises a base. The base is checked
# whole before any record or charge (its pins, its size, the schema, the program check, its findings), its design is
# kept, its first call is the revise, and the model reads it as data.
mutate "a revision's base of another manifest taken" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/if \(!pinned\.get\(key\)\.equals\(versions\.path\(key\)\.asText\(null\)\)\) \{/if (false) {/'
mutate "a revision's base off the schema taken" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/if \(!problems\.isEmpty\(\)\) \{(\s*throw ModuleRequest\.bad\("base does not fit)/if (false) {$1/'
mutate "a revision's base failing the host's check taken" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/if \(!failing\.isEmpty\(\)\) \{/if (false) {/'
mutate "a revision's findings uncounted" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/if \(!list\.isArray\(\) \|\| list\.isEmpty\(\) \|\| list\.size\(\) > MAX_FINDINGS\) \{/if (!list.isArray()) {/'
mutate "a revision's base unbounded" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/if \(ModuleRequest\.utf8\(base\.toString\(\)\) > MAX_BASE_BYTES\) \{/if (false) {/'
mutate "a revision's base ignored" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/AgentBase base = body\.has\("base"\) \? loop\.base\(body\.path\("base"\), bundle\.bundleHash\(\)\) : null;/AgentBase base = null;/'
mutate "a revision's design not kept" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/JsonNode design = fixedDesign != null \? fixedDesign : proposed;/JsonNode design = proposed;/'
mutate "a revision whose first call is no revise" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/purpose = "revise";/purpose = "first";/'
mutate "a revision's prompt without its base" "$S/templates/PromptBuilder.java" forge-service AgentLoopTest \
    's/return agent\(request, style, seconds, budgets, base\.toString\(\)\);/return agent(request, style, seconds, budgets, "");/'
mutate "a revision's findings read as instructions" "$S/templates/PromptBuilder.java" forge-service AgentLoopTest \
    's/\.append\(": "\)\.append\(quoted\(f\.message\(\)\)\);/.append(": ").append(f.message());/'
# Live on the VPS (2026-11-01): the browser refused each of the first three agent.v3 hand-offs on a Tier-1 rule this
# check did not hold. Both are held now, so the turn's own revision answers them.
mutate "a check that lets two nodes share a module" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(first != null\) \{/if (false) {/'
mutate "a check that lets after cross phases" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(!phase\.equals\(theirs\)\) \{/if (false) {/'
# The EA4.4 review (2026-11-01): an anonymous creator's revision went at once (two turns of room), and no hand-off is too
# large for the base of its revision.
mutate "an anonymous turn bucket of one turn, refusing the revision" "$G/shield/GatewayShieldProperties.java" forge-gateway ForgeRoutesTest \
    's/\("agent-turn-anonymous", new Bucket\(AgentTurn\.MAX_CALLS \/ 120\.0, 2 \* AgentTurn\.MAX_CALLS,/("agent-turn-anonymous", new Bucket(AgentTurn.MAX_CALLS \/ 120.0, AgentTurn.MAX_CALLS,/'
mutate "a hand-off too large for the base of its revision" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(bytes > room\) \{/if (false) {/'
# Q84 revised (2026-11-02; the frontend's candidate-loop design §8): the black hole starter needed about eight modules,
# past the browser's four, and was stopped after its turn was spent. One world builds twelve now, the turn's check and its
# prompt hold a program to them, and the gateway's module buckets pace an attempt's 22 module calls.
mutate "a check that lets a program name more modules than one world builds" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(pastCap != null\) \{/if (false) {/'
mutate "a module budget one past the frontend's" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/owners\.size\(\) == AgentTurn\.MAX_MODULES \+ 1/owners.size() == AgentTurn.MAX_MODULES + 2/'
mutate "the agent prompt saying another module budget" "$S/templates/PromptTemplates.java" forge-service AgentLoopTest \
    's/fill\.put\("maxModules", String\.valueOf\(AgentTurn\.MAX_MODULES\)\);/fill.put("maxModules", "4");/'
mutate "the agent prompt without its module budget" "$R/prompts/agent.v6.md" forge-service AgentLoopTest \
    's/- A program names at most \{\{maxModules\}\} modules: one world builds no more\. A world that needs more\n  merges stages that run in the same phase into one module, or leaves a part out\.\n//'
mutate "an anonymous module bucket of the old seven calls" "$G/shield/GatewayShieldProperties.java" forge-gateway ForgeRoutesTest \
    's/new Bucket\(AgentTurn\.MODULE_CALLS \/ 120\.0, AgentTurn\.MODULE_CALLS\)/new Bucket(7 \/ 120.0, 7)/'
mutate "a signed-in module bucket of the old fourteen calls" "$G/shield/GatewayShieldProperties.java" forge-gateway ForgeRoutesTest \
    's/new Bucket\(AgentTurn\.MODULE_CALLS \/ 60\.0, 2 \* AgentTurn\.MODULE_CALLS\)/new Bucket(7 \/ 60.0, 14)/'
# EA6.3 (2026-11-02; the frontend's visual-review design §8.2, Q111 (a)): a revision's notes to its modules, agent-action.v3.
# The whole plan is judged with the proposal, a revision always hands it off, a first turn's is not used, and an author
# call carries its module's note as data, once; a repair's note is one of its findings.
mutate "a note to a module the program does not name taken" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/\} else if \(!modules\.contains\(module\)\) \{/} else if (false) {/'
mutate "two notes to one module taken" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/\} else if \(!seen\.add\(module\)\) \{/} else if (false \&\& !seen.add(module)) {/'
mutate "a note that says nothing taken" "$S/agent/ProgramCheck.java" forge-service ProgramCheckTest \
    's/if \(ModuleRequest\.blank\(r\.path\("message"\)\.asText\(""\)\)\) \{/if (false) {/'
mutate "a revision's notes not handed off" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/emit\("repairs", "repairs", repairs\);/emit("repairs", "repairs", json.createArrayNode());/'
mutate "a revision with no notes saying nothing" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(baseModules != null\) \{(\s*\/\/ A revision)/if (baseModules != null \&\& !repairs.isEmpty()) {$1/'
mutate "a first turn's notes handed off" "$S/agent/AgentLoop.java" forge-service AgentLoopTest \
    's/if \(baseModules == null\) \{(\s*findings\.add\(Finding\.warn\("repairs-unused")/if (false) {$1/'
mutate "the response format named for another contract" "$S/agent/AgentLoop.java" forge-service AgentRoutesTest \
    's/JsonSchemas\.AGENT_ACTION\.replace\(.-., ._.\)\.replace\(.\.., ._.\)/"agent_action_v2"/'
mutate "a repair's note taken" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/if \(!"author"\.equals\(purpose\)\) \{(\s*throw bad\("A repair)/if (false) {$1/'
mutate "a note past its cap taken" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/codePoints\(text\) > NOTE_CHARS/codePoints(text) > NOTE_CHARS + 1/'
mutate "a note counted in UTF-16 units" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/codePoints\(text\) > NOTE_CHARS/text.length() > NOTE_CHARS/'
mutate "an author's note dropped" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/findings, m\.note\(\)\);/findings, null);/'
mutate "an author's note read as instructions" "$S/templates/PromptBuilder.java" forge-service PromptBuilderTest \
    's/\+ quoted\(note\)\);/+ note);/'
mutate "the agent prompt without its notes" "$R/prompts/agent.v6.md" forge-service AgentLoopTest \
    's/Name a module once, only a module your program names, and at most 12 in all\. //'
mutate "the agent prompt without the scale rule" "$R/prompts/agent.v6.md" forge-service AgentLoopTest \
    's/- A primitive.s size and an instance.s scale multiply:[^\n]*\n[^\n]*\n[^\n]*\n//'
# The independent review of EA6.3 (11-02 night): blank as the browser's trim counts it, and every finding's message in
# code points, as the browser cuts it.
mutate "a note of non-breaking spaces taken" "$S/agent/ModuleRequest.java" forge-service ProgramCheckTest \
    's/ \|\| Character\.isSpaceChar\(c\) \|\| c == 0xFEFF//'
mutate "a repair's finding counted in UTF-16 units" "$S/agent/ModuleRequest.java" forge-service ModuleRoutesTest \
    's/codePoints\(f\.path\("message"\)\.asText\(\)\) > FINDING_CHARS/f.path("message").asText().length() > FINDING_CHARS/'
mutate "a base finding counted in UTF-16 units" "$S/agent/AgentBase.java" forge-service AgentRoutesTest \
    's/ModuleRequest\.codePoints\(v\.asText\(\)\) <= max/v.asText().length() <= max/'

# W1.2 (2026-11-02; the creations platform design §11, PL-T17's ipk): the network an anonymous caller is counted by is the
# address the gateway resolved, an IPv6 address's /64, keyed; never a header the client wrote, never made up without a key.
mutate "ipk from the client's forwarded-for" "$G/shield/ClientNetworkKey.java" forge-gateway ClientNetworkKeyTest \
    's/byte\[\] network = network\(resolver\.resolve\(exchange\)\);/byte[] network = network(String.valueOf(exchange.getRequest().getHeaders().getFirst("X-Forwarded-For")));/'
mutate "ipk keeps a whole IPv6 address" "$G/shield/ClientNetworkKey.java" forge-gateway ClientNetworkKeyTest \
    's/byte\[\] out = new byte\[1 \+ \(bytes\.length == 4 \? 4 : 8\)\];/byte[] out = new byte[1 + bytes.length];/'
# Re-aimed on 2026-11-06: since Q98's revision (account-guards) the key names its family, which the old pattern no longer
# matched.
mutate "ipk unkeyed" "$G/shield/ClientNetworkKey.java" forge-gateway ClientNetworkKeyTest \
    's/\(network\[0\] == 4 \? "v4\." : "v6\."\) \+ hmac\(network\);/(network[0] == 4 ? "v4." : "v6.") + HexFormat.of().formatHex(network);/'
mutate "an unset required network key allowed" "$G/shield/ClientNetworkKey.java" forge-gateway ClientNetworkKeyTest \
    's/if \(required\) \{/if (false) {/'
mutate "no network key in the token" "$G/auth/AuthorizationFilter.java" forge-gateway AuthorizationFilterTest \
    's/minter\.mint\(caller, admin, networkKey\.of\(exchange\), audience\)/minter.mint(caller, admin, null, audience)/'

# W1.3 (2026-11-02; the creations platform design §11, I6, Q95): the spend lanes. The real script's lane check is
# SpendGuardRedisTest's, which needs Docker; these hold the Java around it, hermetically.
mutate "a lane's ceiling never sent" "$S/spend/SpendGuard.java" forge-service SpendGuardTest \
    's/Long\.toString\(laneCap\.dailyMicroUsd\(\)\)\};/"-1"};/'
mutate "a call without a lane allowed" "$S/spend/SpendGuard.java" forge-service SpendGuardTest \
    's/if \(laneCap == null\) \{/if (false) {/'
mutate "a missing lane allowed at startup" "$S/spend/SpendGuard.java" forge-service SpendGuardTest \
    's/if \(lane == null \|\| lane\.dailyMicroUsd\(\) == null\) \{/if (false) {/'
mutate "a settlement that leaves the lane" "$S/spend/SpendGuard.java" forge-service SpendGuardSettlementTest \
    's/adjust\(provider, lane, receipt\.keys\(\), delta, providerCap, detail\)/adjust(provider, lane, receipt.keys().subList(0, 4), delta, providerCap, detail)/'

# W1.4 (2026-11-02; the creations platform design §11, I6, I11, I12, I13): roles, prompt grants and follow-ups. The real
# grant scripts are RedisGrantStoreTest's, which needs Docker; these hold the Java around them, hermetically.
A=$S/allowance
mutate "an anonymous token taken for an account" "$A/Role.java" forge-service RoleTest \
    's/        if \(caller\.anonymous\(\)\) \{\n            return ANONYMOUS;\n        \}\n//'
mutate "anonymous prompts charged to early access's lane" "$A/Role.java" forge-service RoleTest \
    's/ANONYMOUS\(SpendGuard\.LANE_ANONYMOUS, "Free"\)/ANONYMOUS(SpendGuard.LANE_EARLY_ACCESS, "Free")/'
mutate "an anonymous caller without a network granted" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/case ANONYMOUS -> caller\.ipk\(\) == null \? null : /case ANONYMOUS -> false ? null : /'
mutate "the network not counted" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/PREFIX \+ "net:" \+ day \+ ":" \+ caller\.ipk\(\)\)/PREFIX + "anon:" + owner)/'
mutate "a spent day granted anyway" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/        if \(denied >= 0\) \{/        if (false) {/'
mutate "quota without its reset" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/"Today.s world is made; the next opens at the day.s reset\.", seconds\)/"Today\x27s world is made.", null)/'
mutate "a follow-up past its budget" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/case REVISION -> properties\.revisions\(\);/case REVISION -> Long.MAX_VALUE;/'
mutate "a revision of another prompt joined" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/store\.join\(GRANT \+ grantId, owner, kind\.field, limit\(kind\), promptHash,/store.join(GRANT + grantId, owner, kind.field, limit(kind), null,/'
mutate "a prompt never given back" "$A/Grant.java" forge-service PromptGrantsTest \
    's/: store\.release\(recordKey, indexKey, counters\);/: false;/'
# An entry's order: the allowance, then the idea's content safety, then the grant. Held on the turn route since EA9.6
# (2026-11-06), as h1's AllowanceRoutesTest held it on the plan route; its Director turn went with h1's routes.
mutate "an unsafe idea let through" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/        grants\.check\(caller\);\n        checkSafety\(text, route\);/        grants.check(caller);/'
mutate "the safety check before the allowance" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/        grants\.check\(caller\);\n        checkSafety\(text, route\);/        checkSafety(text, route);/'

# The W1 review (2026-11-02): a module call runs inside its turn's granted prompt, carrying that prompt, within its
# budget; an admission its request left mid-way gives its grant back; Retry-After never ends before the reset.
mutate "a module call outside its prompt" "$S/agent/ModuleHandler.java" forge-service ModuleRoutesTest \
    's/admission\.module\(caller, m\.turnId\(\), m\.request\(\)\.prompt\(\)\);/m.turnId();/'
mutate "a module call's idea unchecked" "$A/PromptAdmission.java" forge-service ModuleRoutesTest \
    's/PromptGrants\.Kind\.MODULE, sha256\(prompt\), null\)/PromptGrants.Kind.MODULE, null, null)/'
mutate "module calls past their budget" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/case MODULE -> properties\.moduleCalls\(\);/case MODULE -> Long.MAX_VALUE;/'
mutate "a cancelled admission keeping its grant" "$A/PromptAdmission.java" forge-service OffLoopAdmissionTest \
    's/                            if \(grant != null\) \{\n                                grant\.release\(\);\n                            \}\n//'
mutate "a dropped admission keeping its grant" "$A/PromptAdmission.java" forge-service OffLoopAdmissionTest \
    's/Schedulers\.boundedElastic\(\)\.schedule\(\(\(Grant\) grant\)::release\)\)\);/Schedulers.boundedElastic().schedule(() -> { })));/'
mutate "Retry-After floored" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/Math\.ceilDiv\(millis, 1000L\)/millis \/ 1000L/'

# The W1 bug hunt (2026-11-02): a turn is admitted before anything is recorded or sent. Its plan route's half (a plan's
# authors, repairs and re-plan inside its prompt) went with h1's routes at EA9.6; Q120 (b)'s follow-up is below.
mutate "a turn not admitted" "$S/agent/AgentHandler.java" forge-service AgentRoutesTest \
    's/: admission\.entry\(caller, turnId, turn\.prompt\(\), "turn"\)\)/: null)/'

# EA9.6's independent review (2026-11-06): what h1's deleted tests alone held. A turn's request caps (h1's plan route's
# test, while AgentRequest.validated checks every turn), the allowance read never cached (h1's AllowanceRoutesTest), and
# the mock profile answering on the loopback only (its Docker-backed test, now hermetic).
mutate "a style none of the five taken" "$S/agent/AgentRequest.java" forge-service AgentRoutesTest \
    's/if \(style == null \|\| !STYLES\.contains\(style\)\) \{/if (style == null) {/'
mutate "seconds past the longest taken" "$S/agent/AgentRequest.java" forge-service AgentRoutesTest \
    's/ \|\| seconds > caps\.maxSeconds\(\)\) \{/ || seconds > caps.maxSeconds() + 1) {/'
mutate "seconds under the shortest taken" "$S/agent/AgentRequest.java" forge-service AgentRoutesTest \
    's/seconds < caps\.minSeconds\(\)/seconds < caps.minSeconds() - 1/'
mutate "a prompt counted in bytes" "$S/agent/AgentRequest.java" forge-service AgentRoutesTest \
    's/prompt\.codePointCount\(0, prompt\.length\(\)\) > caps\.promptChars\(\)/prompt.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > caps.promptChars()/'
mutate "the allowance cached" "$A/AllowanceHandler.java" forge-service TurnAllowanceRoutesTest \
    's/\.header\(HttpHeaders\.CACHE_CONTROL, "no-store"\)//'
mutate "a mock that answers off the loopback" "$S/mock/MockMetaApi.java" forge-service MockMetaApiTest \
    's/if \(!"127\.0\.0\.1"\.equals\(base\.getHost\(\)\) \|\| base\.getPort\(\) != properties\.port\(\) \|\| !"\/v1"\.equals\(base\.getPath\(\)\)\) \{/if (false) {/'
mutate "a mock template without a recording answered" "$S/mock/MockMetaApi.java" forge-service MockMetaApiTest \
    's/        if \(!template\.equals\("agent"\)\) \{\n.*?\n            return;\n        \}\n//s'

# Q120 (b) (EA9.5, 2026-11-05; the creations platform design §10, "Q120's follow-up"): a turn that ended with no world is
# followed once inside its prompt, its changed idea screened; any other follow-up is 409, never an entry; one that
# dispatched nothing is given back; only an entry turn and a follow-up write their end. The real scripts are
# RedisGrantStoreTest's (Docker); the route's are TurnAllowanceRoutesTest's, hermetic.
mutate "Q120 a follow-up taken as an entry" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/\? admission\.followUp\(caller, retryOf, turnId, turn\.prompt\(\)\)/? admission.entry(caller, turnId, turn.prompt(), "turn")/'
mutate "Q120 no end written" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/\n\s*grant\.ended\(endOf\(outcome\), dispatched\.get\(\)\);//'
mutate "Q120 a retryOf beside a base" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/if \(body\.has\("base"\)\) \{\n(\s*)throw new ForgeException\(ErrorCode\.BAD_REQUEST, "retryOf is for/if (false) {\n${1}throw new ForgeException(ErrorCode.BAD_REQUEST, "retryOf is for/'
mutate "Q120 a retryOf that is no turn's id" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/if \(!value\.isTextual\(\) \|\| !ModuleRequest\.ULID\.matcher\(value\.asText\(\)\)\.matches\(\)\) \{/if (!value.isTextual()) {/'
mutate "Q120 a changed idea unscreened" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/\n\s*checkSafety\(prompt, "follow-up"\);//'
mutate "Q120 the same idea screened again" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/if \(may == GrantStore\.Follow\.CHANGED\) \{/if (true) {/'
mutate "Q120 a refused follow-up made an entry" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/log\.info\("allowance\.follow-up refused=\{\}", may\.name\(\)\.toLowerCase\(\)\);\n\s*throw new ForgeException\(ErrorCode\.CONFLICT, CANNOT_FOLLOW\);/return entry(caller, turnId, prompt, "turn");/'
mutate "Q120 a lost join made an entry" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/if \(joined == null\) \{\n(\s*)throw new ForgeException\(ErrorCode\.CONFLICT, CANNOT_FOLLOW\);/if (joined == null) {\n${1}return entry(caller, turnId, prompt, "turn");/'
mutate "Q120 follow-ups past their one" "$A/PromptGrants.java" forge-service TurnAllowanceRoutesTest \
    's/properties\.followUps\(\)/1000/g'
mutate "Q120 a follow-up never given back" "$A/Grant.java" forge-service TurnAllowanceRoutesTest \
    's/followUp\(\) \? store\.unfollow\(recordKey, indexKey, turnId\)/followUp() ? false/'
mutate "Q120 an unwinding turn not waited for" "$A/PromptAdmission.java" forge-service TurnAllowanceRoutesTest \
    's/may == GrantStore\.Follow\.OPEN && waited < UNWIND_WAIT_MILLIS;/may == GrantStore.Follow.OPEN \&\& waited < 0;/'
mutate "Q120 the real join follows another owner's turn" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if redis\.call\(\x27HGET\x27, record, \x27owner\x27\) ~= ARGV\[1\] then return \x27NONE\x27 end\\n"(\n\s*\+ "local used = tonumber\(redis\.call\(\x27HGET\x27, record, \x27followups\x27\))/+ ""$1/'
mutate "Q120 the real join follows past its one" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if used >= tonumber\(ARGV\[2\]\) then return \x27FULL\x27 end\\n"/+ ""/'
mutate "Q120 the real join follows a world" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if not followable\[ended\] then return \x27WORLD\x27 end\\n"(\n\s*\+ "local prompt = redis\.call)/+ ""$1/'
mutate "Q120 the real probe says a world may be followed" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if not followable\[ended\] then return \x27WORLD\x27 end\\n"(\n\s*\+ "if redis\.call\(\x27HGET\x27, record, \x27prompt\x27\) == ARGV\[3\])/+ ""$1/'
mutate "Q120 the real end written by another turn before a follow-up" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "elseif redis\.call\(\x27HGET\x27, record, \x27entry\x27\) ~= ARGV\[1\] then return \x27OTHER\x27 end\\n"/+ "end\\n"/'
mutate "Q120 the real end written by the entry after a follow-up" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "  if following ~= ARGV\[1\] then return \x27OTHER\x27 end\\n"/+ ""/'
mutate "Q120 the real give-back of a spent follow-up" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if redis\.call\(\x27HGET\x27, record, \x27followDispatched\x27\) == \x271\x27 then return \x27SPENT\x27 end\\n"/+ ""/'
# Q120 (b)'s count (2026-11-06, the user: "yes u can go ahead with api change"; the creations platform design §10): a
# turn's end keeps the calls it dispatched (its `call` events, not the loop's count), the join answers them, a give-back
# restores them, and a follow-up's meta says them, null when unknown.
mutate "Q120 count: the loop's count kept, not the calls dispatched" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/grant\.ended\(endOf\(outcome\), dispatched\.get\(\)\)/grant.ended(endOf(outcome), outcome.calls())/'
mutate "Q120 count: every event counted as a call" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/if \("call"\.equals\(event\.name\(\)\)\) \{/if (true) {/'
mutate "Q120 count: a follow-up's meta names no turn" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/\n\s*meta\.put\("followed", f\);//'
mutate "Q120 count: a follow-up's meta says no calls" "$S/agent/AgentHandler.java" forge-service TurnAllowanceRoutesTest \
    's/f\.put\("calls", followed\.calls\(\)\);/f.put("calls", null);/'
mutate "Q120 count: the follow-up's grant forgets the calls" "$A/PromptGrants.java" forge-service PromptGrantsTest \
    's/new Grant\.Followed\(namedTurnId, joined\.end\(\), joined\.calls\(\)\)/new Grant.Followed(namedTurnId, joined.end(), null)/'
mutate "Q120 count: an end written with no calls" "$A/Grant.java" forge-service TurnAllowanceRoutesTest \
    's/store\.ended\(recordKey, turnId, end, calls\)/store.ended(recordKey, turnId, end, 0)/'
mutate "Q120 count: a stored count below zero read as one" "$A/RedisGrantStore.java" forge-service PromptGrantsTest \
    's/return n >= 0 \? n : null;/return n;/'
mutate "Q120 count: the real join answers no calls" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/return \x27JOINED\|\x27 \.\. ended \.\. \x27\|\x27 \.\. \(calls or \x27\x27\)/return \x27JOINED|\x27 .. ended .. \x27|\x27/'
mutate "Q120 count: the real join keeps no calls to give back" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if calls then redis\.call\(\x27HSET\x27, record, \x27prevEndCalls\x27, calls\) end\\n"/+ ""/'
mutate "Q120 count: the real give-back restores no calls" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\+ "if calls then redis\.call\(\x27HSET\x27, record, \x27endCalls\x27, calls\) else redis\.call\(\x27HDEL\x27, record, \x27endCalls\x27\) end\\n"/+ ""/'
mutate "Q120 count: the real end writes no calls" "$A/RedisGrantStore.java" forge-service RedisGrantStoreTest \
    's/\x27end\x27, ARGV\[2\], \x27endCalls\x27, ARGV\[3\]/\x27end\x27, ARGV[2]/'

# W1.5 (2026-11-02; the creations platform design §11, I12, Q99): Azure AI Content Safety fails closed. No verdict is
# no call; each category refuses at its threshold; the recorded verdicts never run outside the local and test profiles.
C=$S/safety
mutate "content safety failing open on an error status" "$C/AzureContentSafety.java" forge-service AzureContentSafetyTest \
    's/throw unavailable\("status " \+ e\.getStatusCode\(\)\.value\(\)\);/return new Verdict(true, Map.of());/'
mutate "content safety with no deadline" "$C/AzureContentSafety.java" forge-service AzureContentSafetyTest \
    's/\n                    \.timeout\(timeout\)//'
mutate "a verdict on a partial answer" "$C/AzureContentSafety.java" forge-service AzureContentSafetyTest \
    's/if \(!severities\.keySet\(\)\.containsAll\(CATEGORIES\)\) \{/if (false) {/'
mutate "a threshold one level late" "$C/AzureContentSafety.java" forge-service AzureContentSafetyTest \
    's/severities\.get\(c\) < refuseAt\.get\(c\)/severities.get(c) <= refuseAt.get(c)/'
mutate "content safety starting without its key" "$C/AzureContentSafety.java" forge-service AzureContentSafetyTest \
    's/if \(endpoint\.isEmpty\(\) \|\| key\.isEmpty\(\)\) \{/if (endpoint.isEmpty()) {/'
mutate "the recorded verdicts in a deployment" "$C/RecordedContentSafety.java" forge-service ContentSafetyProfilesTest \
    's/\@Profile\(\{"local", "test"\}\)/\@Profile({"local", "test", "prod"})/'

# EA6.4 (the frontend's visual-review design §9.1; Q62's gates, Q112 (a)): a model's review refuses before any record or
# charge while a gate is unverified; its frames are checked whole and never echoed; an answer is a verdict only when it
# keeps its rules and has its usage; images are bounded in the reservation, inline, and blanked in every excerpt; the
# review's route alone takes a larger body, and spends its App Check token.
V=$S/agent
mutate "a review with a gate unverified" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/        if \(unmet != null\) \{/        if (false) {/'
# The independent review of EA6.4: a contributor-mode model keeps the privacy gate shut (R13); only a probe report's name
# opens the probe's two gates.
mutate "a contributor model reviewed" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/gates\.put\("privacy", gates\.get\("privacy"\) && "standard"\.equals\(mode\(model\(\)\)\)\);/gates.put("privacy", gates.get("privacy"));/'
mutate "any value opens the probe's gates" "$V/ReviewProperties.java" forge-service ReviewRoutesTest \
    's/if \(!probe\.isEmpty\(\) && !PROBE_REPORT\.matcher\(probe\)\.matches\(\)\) \{/if (false) {/'
mutate "an unverified gate reported verified" "$V/ReviewProperties.java" forge-service ReviewRoutesTest \
    's/gates\.put\("metering", imageTokens != null\);/gates.put("metering", true);/'
mutate "a frame's hash not checked" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(!sha256\.equals\(sha256\(jpeg\)\)\) \{/if (false) {/'
mutate "a frame of another size" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(whole\.width\(\) != WIDTH \|\| whole\.height\(\) != HEIGHT\) \{/if (false) {/'
# The base64's length bounds the bytes before they are decoded, and the decoded length again: one byte over must
# pass both to be taken, so both move together (either alone is held by the other).
mutate "a frame one byte over" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(text\.length\(\) > MAX_BASE64_CHARS\) \{/if (text.length() > MAX_BASE64_CHARS + 4) {/; s/if \(bytes\.length > MAX_JPEG_BYTES\) \{/if (bytes.length > MAX_JPEG_BYTES + 1) {/'
mutate "a cut JPEG taken" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/ \|\| \(b\[n - 2\] & 0xFF\) != 0xFF \|\| \(b\[n - 1\] & 0xFF\) != 0xD9\) \{/) {/'
# The outside review of EA6.4: a frame is a whole image, its structure walked to its end and its image decoded.
mutate "a frame's image not decoded" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/String undecodable = undecodable\(whole\);/String undecodable = null;/'
mutate "a decoder's warning taken" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(!warnings\.isEmpty\(\)\) \{/if (false) {/'
mutate "a frame's metadata decoded" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(!metadata\) \{/if (true) {/'
mutate "a frame's scans unbounded" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(whole\.scans\(\) > MAX_SCANS\) \{/if (false) {/'
mutate "a scan with no data taken" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(j == end\) \{/if (false) {/'
mutate "a second frame header taken" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(components != null\) \{/if (false) {/'
mutate "bytes after a frame's end taken" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/if \(i != n - 2\) \{/if (false) {/'
mutate "a consent to another policy" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/\n                \|\| !policyVersion\.equals\(consent\.path\("policyVersion"\)\.asText\(null\)\)\) \{/) {/'
mutate "a review of one module's subject" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/(for \(String key : List\.of\("module", "interfaceHash", "codeHash"\)\) \{\n            )if \(!s\.path\(key\)\.isNull\(\)\) \{/${1}if (false) {/'
mutate "a pass with issues" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/if \("pass"\.equals\(verdict\) && count > 0\) \{/if (false) {/'
mutate "a module the request did not name" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/if \(!modules\.contains\(m\.asText\(\)\)\) \{/if (false) {/'
mutate "a verdict without usage" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/        if \(usage == null\) \{/        if (false) {/'
mutate "another caller's turn reviewed" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/ && g\.uid\(\)\.equals\(caller\.uid\(\)\)\);\n        if \(!owned\)/);\n        if (!owned)/'
mutate "a turn's owner asked after its frames" "$V/ReviewRequest.java" forge-service ReviewRequestTest \
    's/        owner\.accept\(turnId\);\n//'
mutate "text after a verdict taken" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/new ObjectMapper\(\)\.enable\(DeserializationFeature\.FAIL_ON_TRAILING_TOKENS\);/new ObjectMapper();/'
mutate "text after a probe's verdict taken" "$V/VisionProbe.java" forge-service VisionProbeTest \
    's/new ObjectMapper\(\)\.enable\(com\.fasterxml\.jackson\.databind\.DeserializationFeature\.FAIL_ON_TRAILING_TOKENS\);/new ObjectMapper();/'
mutate "a module named twice in an issue" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/\} else if \(!named\.add\(m\.asText\(\)\)\) \{/} else if (false) {/'
mutate "an image's bound left out" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/images\.add\(new ChatMessage\.Image\(f\.jpeg\(\), review\.imageTokens\(\)\)\);/images.add(new ChatMessage.Image(f.jpeg(), 1));/'
mutate "an answer cut at its cap taken" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/if \("length"\.equals\(finish\)\) \{/if (false) {/'
mutate "a declined answer taken" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/if \(finish != null && !"stop"\.equals\(finish\)\) \{/if (false) {/'
mutate "a review outside its turn's prompt" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/admission\.review\(caller, r\.turnId\(\), r\.request\(\)\.prompt\(\)\);/caller.uid();/'
mutate "reviews past their budget" "$A/PromptGrants.java" forge-service ReviewRoutesTest \
    's/case REVIEW -> properties\.reviewCalls\(\);/case REVIEW -> Long.MAX_VALUE;/'
mutate "the review's body read unbounded" "$V/ReviewHandler.java" forge-service ReviewRoutesTest \
    's/, ReviewRequest\.MAX_REQUEST_BYTES\)\n                \.map/)\n                .map/'
mutate "an image charged as free" "$S/models/ModelCatalog.java" forge-service ModelCatalogTest \
    's/tokens = Math\.addExact\(tokens, image\.boundTokens\(\)\);/tokens = Math.addExact(tokens, 0);/'
mutate "a frame echoed in a log" "$S/upstream/MetaApiClient.java" forge-service MetaApiClientTest \
    's/clean = blankDataUrls\(clean\);/clean = clean.strip();/'
mutate "an image sent as a remote URL" "$S/upstream/MetaApiClient.java" forge-service MetaApiClientTest \
    's/\.put\("url", "data:image\/jpeg;base64," \+ /.put("url", "https:\/\/example.invalid\/" + /'
# Re-aimed at the merge with W2, whose pattern caps replaced EA6.4's exact-match map: a path no cap matches takes the
# review's 1 MiB instead of the default.
mutate "every route takes the review's body" "$G/shield/GatewayShieldProperties.java" forge-gateway ForgeRoutesTest \
    's/            \}\n            return maxBytes;/            }\n            return 1_048_576L;/'
mutate "the guard caps every route alike" "$G/shield/RequestGuardFilter.java" forge-gateway GatewayShieldTests \
    's/return properties\.getBody\(\)\.limitFor\(request\.getMethod\(\)\.name\(\), request\.getPath\(\)\.pathWithinApplication\(\)\.value\(\)\);/return properties.getBody().getMaxBytes();/'
mutate "the review's token cached" "$G/routes/ForgeRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.filter\(rateLimits\.byClient\("agent-review"\)\)\n                \.filter\(appCheck)\.singleUse\(\)\)/${1})/'

# W2 (2026-11-03; the creations platform design §10, §14, PL-T3, PL-T17): the gateway's edge for the platform, the
# audience that keeps each service's tokens its own, and the accounts. The last five need Docker (a real MariaDB).
K=forge-common/src/main/java/ai/wexy/common
P=platform-service/src/main/java/ai/wexy/platform
M=platform-service/src/main/resources/db/migration/V1__accounts.sql
mutate "a token for any service accepted" "$K/InternalTokenVerifier.java" forge-common InternalTokenVerifierTest \
    's/new DefaultJWTClaimsVerifier<>\(audience,/new DefaultJWTClaimsVerifier<>((String) null,/'
mutate "a token minted for no service" "$G/auth/InternalTokenMinter.java" forge-gateway AuthorizationFilterTest \
    's/\n\s*\.audience\(java\.util\.Objects\.requireNonNull\(audience, "audience"\)\)//'
mutate "forge taking the platform's tokens" "$S/identity/InternalTokenFilter.java" forge-service InternalTokenFilterTest \
    's/new InternalTokenVerifier\(keys, InternalToken\.AUDIENCE_FORGE\)/new InternalTokenVerifier(keys, InternalToken.AUDIENCE_PLATFORM)/'
mutate "the worlds still forge's public reads" "$S/identity/InternalTokenFilter.java" forge-service InternalTokenFilterTest \
    's/"\/v1\/forge\/mode", "\/v1\/archive\/match", "\/v1\/stats",/"\/v1\/forge\/mode", "\/v1\/archive\/match", "\/v1\/stats", "\/v1\/worlds\/{id}", "\/v1\/showcase",/'
mutate "the platform's account routes minting forge's anonymous token" "$G/routes/PlatformRoutes.java" forge-gateway PlatformRoutesTest \
    's/\.filter\(authorization\.platformAccount\(\)\)/.filter(authorization.anonymousAllowed())/'
mutate "the platform's admin routes behind forge's" "$G/routes/PlatformRoutes.java" forge-gateway PlatformRoutesTest \
    's/public static final int AHEAD_OF_FORGE = -1;/public static final int AHEAD_OF_FORGE = 1;/'
mutate "a save spending App Check" "$G/routes/PlatformRoutes.java" forge-gateway ForgeRoutesTest \
    's/(\.route\("worlds-create", r -> r\.path\("\/v1\/worlds"\)\.and\(\)\.method\(HttpMethod\.POST\)\n\s*\.filters\(signedIn\(rateLimits, )cached/$1spent/'
mutate "a world readable without a sign-in" "$G/routes/PlatformRoutes.java" forge-gateway PlatformRoutesTest \
    's/(\.route\("worlds-read", r -> r\.path\("\/v1\/worlds\/\{id\}"\)\.and\(\)\.method\(HttpMethod\.GET\)\n\s*)\.filters\(signedIn\(rateLimits, cached, authorization, "account-read"\)\)/$1.filters(publicRead)/'
mutate "a DELETE's body uncapped" "$G/shield/RequestGuardFilter.java" forge-gateway RequestGuardFilterTest \
    's/HttpMethod\.PATCH,\n\s*HttpMethod\.DELETE\);/HttpMethod.PATCH);/'
mutate "a save's cap on every route" "$G/shield/GatewayShieldProperties.java" forge-gateway RequestGuardFilterTest \
    's/if \(cap\.method\(\)\.equals\(method\) && cap\.pattern\(\)\.matches\(container\)\) \{/if (true) {/'
mutate "a cap whatever the method" "$G/shield/GatewayShieldProperties.java" forge-gateway RequestGuardFilterTest \
    's/if \(cap\.method\(\)\.equals\(method\) && cap\.pattern\(\)\.matches\(container\)\) \{/if (cap.pattern().matches(container)) {/'
mutate "a DELETE's preflight refused" "$G/cors/CorsPolicy.java" forge-gateway CorsPolicyTest \
    's/HttpMethod\.PATCH,\n\s*HttpMethod\.DELETE, HttpMethod\.OPTIONS\)/HttpMethod.PATCH, HttpMethod.OPTIONS)/'
mutate "the idempotency key's preflight refused" "$G/cors/CorsPolicy.java" forge-gateway CorsPolicyTest \
    's/AppCheckFilter\.APP_CHECK_HEADER, IDEMPOTENCY_KEY\);/AppCheckFilter.APP_CHECK_HEADER);/'
mutate "an anonymous caller given an account" "$P/identity/InternalTokenFilter.java" platform-service InternalTokenFilterTest \
    's/if \(claims\.anonymous\(\)\) \{/if (false) {/'
mutate "the platform taking forge's tokens" "$P/identity/InternalTokenFilter.java" platform-service InternalTokenFilterTest \
    's/new InternalTokenVerifier\(keys, InternalToken\.AUDIENCE_PLATFORM\)/new InternalTokenVerifier(keys, InternalToken.AUDIENCE_FORGE)/'
mutate "a handle stored as typed" "$P/account/Handle.java" platform-service HandleTest \
    's/String handle = raw\.toLowerCase\(Locale\.ROOT\);/String handle = raw;/'
mutate "a handle starting wexy claimed" "$P/account/Handle.java" platform-service HandleTest \
    's/if \(reserved\.contains\(handle\) \|\| reservedPrefixes\.stream\(\)\.anyMatch\(handle::startsWith\)\) \{/if (reserved.contains(handle)) {/'
mutate "a look-alike handle taken" "$P/account/Handle.java" platform-service HandleTest \
    's/Pattern\.compile\("\[A-Za-z0-9_\]\{3,30\}"\)/Pattern.compile("(?U)\\\\w{3,30}")/'
mutate "a change made for another account written" "$P/account/Accounts.java" platform-service AccountRoutesTest \
    's/if \(!account\.id\(\)\.equals\(patch\.accountId\(\)\)\) \{/if (false) {/'
mutate "a change that names no account taken" "$P/account/ProfilePatch.java" platform-service AccountRoutesTest \
    's/if \(account == null \|\| !account\.isTextual\(\) \|\| !Ulid\.looksLikeOne\(account\.textValue\(\)\)\) \{/if (false) {/'
mutate "a second tab's claim judged as a change" "$P/account/Accounts.java" platform-service AccountRoutesTest \
    's/if \(patch\.expectedVersion\(\) != current\.rowVersion\(\)\) \{/if (false) {/'
mutate "a claimed handle changed" "$P/account/Accounts.java" platform-service AccountRoutesTest \
    's/if \(handle != null && !handle\.equals\(wanted\)\) \{/if (false) {/'
mutate "a bootstrap taking a client's fields" "$P/account/AccountHandler.java" platform-service AccountRoutesTest \
    's/return body != null && body\.isObject\(\) && body\.isEmpty\(\);/return body != null \&\& body.isObject();/'
mutate "a profile change taking an owner or a status" "$P/account/ProfilePatch.java" platform-service AccountRoutesTest \
    's/if \(!FIELDS\.contains\(name\)\) \{/if (false) {/'
mutate "text past its column" "$P/account/ProfilePatch.java" platform-service AccountRoutesTest \
    's/if \(value\.codePointCount\(0, value\.length\(\)\) > maxCodePoints\) \{/if (false) {/'
mutate "a control character in a display name" "$P/account/ProfilePatch.java" platform-service AccountRoutesTest \
    's/if \(Character\.isISOControl\(c\) \|\| \(c >= Character\.MIN_SURROGATE && c <= Character\.MAX_SURROGATE\)\) \{/if (false) {/'
mutate "a direction override in a display name" "$P/account/ProfilePatch.java" platform-service AccountRoutesTest \
    's/if \(c == 0x2028 \|\| c == 0x2029 \|\| \(c >= 0x202A && c <= 0x202E\) \|\| \(c >= 0x2066 && c <= 0x2069\)\) \{/if (false) {/'
mutate "an account key optional in prod" "$P/account/SubjectKey.java" platform-service SubjectKeyTest \
    's/if \(required\) \{/if (false) {/'
mutate "a subject stored as its uid" "$P/account/SubjectKey.java" platform-service SubjectKeyTest \
    's/return HexFormat\.of\(\)\.formatHex\(mac\.doFinal\(uid\.getBytes\(StandardCharsets\.UTF_8\)\)\);/return uid;/'
mutate "a profile written at any version" "$P/account/JdbcAccountStore.java" platform-service JdbcAccountStoreTest \
    's/\n\s*AND row_version = :expected//'
mutate "a claimed handle overwritten in the database" "$P/account/JdbcAccountStore.java" platform-service JdbcAccountStoreTest \
    's/\n\s*AND \(handle_normalized IS NULL OR handle_normalized = :handle\)//'
mutate "an inactive account's profile written" "$P/account/JdbcAccountStore.java" platform-service JdbcAccountStoreTest \
    's/\n\s*AND account_id IN \(SELECT id FROM account WHERE id = :id AND status = \x27ACTIVE\x27\)//'
mutate "a transaction that cannot start answered 500" "$P/error/ErrorEnvelopeHandler.java" platform-service ErrorEnvelopeHandlerTest \
    's/ \|\| causedBy\(error, TransactionException\.class\)\n\s*\|\| causedBy\(error, SQLException\.class\)/\n               /'
mutate "the database's queue bound per thread" "$P/database/DatabaseScheduler.java" platform-service DatabaseSchedulerTest \
    's/Math\.max\(1, queuedCalls \/ poolSize\)/queuedCalls/'
mutate "the account read without a token" "$P/identity/InternalTokenFilter.java" platform-service InternalTokenFilterTest \
    's/"GET \/v1\/showcase", /"GET \/v1\/showcase", "GET \/v1\/me", /'
mutate "a deadlock's victim answered 503" "$P/account/JdbcAccountStore.java" platform-service JdbcAccountStoreTest \
    's/static final int DEADLOCK_ATTEMPTS = 4;/static final int DEADLOCK_ATTEMPTS = 1;/'
mutate "two accounts for one subject" "$M" platform-service JdbcAccountStoreTest \
    's/\n\s*UNIQUE KEY account_subject \(subject_hmac\),//'
mutate "two owners for one handle" "$M" platform-service JdbcAccountStoreTest \
    's/\n\s*UNIQUE KEY profile_handle \(handle_normalized\),//'

# W3 (2026-11-03 evening; the creations platform design §5, §7, §10, PL-T2, PL-T4 to PL-T8): a saved world's checks, the
# store's ownership, compare-and-set, caps and reservations, retention and cleanup. The store's need Docker (MariaDB).
V=platform-service/src/main/resources/db/migration/V2__worlds.sql
mutate "W3 a text not its hash saved" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \(!sha256\.equals\(claimedSha256\)\) \{/if (false) {/'
mutate "W3 a text not canonical saved" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \(problem != null\) \{/if (false) {/'
mutate "W3 an h1 world saved" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \("h1"\.equals\(world\.path\("kind"\)\.asText\(null\)\)\) \{/if (false) {/'
mutate "W3 the world's schema not checked" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \(!problems\.isEmpty\(\)\) \{/if (false) {/'
mutate "W3 a hash of another shape kept" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \(value == null \|\| !HEX64\.matcher\(value\.asText\(\)\)\.matches\(\)\) \{/if (false) {/'
mutate "W3 a text past the cap kept" "$P/world/WorldCheck.java" platform-service WorldCheckTest \
    's/if \(bytes\.length > MAX_BYTES\) \{/if (false) {/'
mutate "W3 keys kept in their own order" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/Map<String, Object> sorted = new TreeMap<>\(object\);/Map<String, Object> sorted = object;/'
mutate "W3 an integer past 2^53 written" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/if \(d == Math\.rint\(d\) && Math\.abs\(d\) >= SAFE_LIMIT\) \{/if (false) {/'
mutate "W3 a duplicate key kept" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/if \(object\.containsKey\(key\)\) \{/if (false) {/'
mutate "W3 the farther decimal written" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/return nearer < 0 \? below : above;/return below;/'
mutate "W3 a deep text read without a bound" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/if \(depth > MAX_DEPTH\) \{/if (false) {/'
mutate "W3 a lone surrogate written raw" "$P/world/CanonicalText.java" platform-service CanonicalTextTest \
    's/\} else if \(Character\.isSurrogate\(c\)\) \{\n(\s*)unicode\(c, out\);/} else if (Character.isSurrogate(c)) {\n${1}out.append(c);/'
mutate "W3 a revision committed on a moved head" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(world\.isEmpty\(\) \|\| !world\.get\(\)\.head\(\)\.equals\(save\.baseRevisionId\(\)\)\n\s*\|\| world\.get\(\)\.rowVersion\(\) != save\.expectedVersion\(\)\) \{/if (world.isEmpty()) {/'
mutate "W3 a stale base begun" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(!world\.head\(\)\.equals\(s\.baseRevisionId\(\)\) \|\| world\.rowVersion\(\) != s\.expectedVersion\(\)\) \{/if (false) {/'
mutate "W3 another owner's world read" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/WHERE c\.id = :id AND c\.owner_id = :owner AND c\.status = \x27ACTIVE\x27/WHERE c.id = :id AND c.status = \x27ACTIVE\x27/'
mutate "W3 another owner's revision read" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/AND r\.creation_id = :world AND c\.owner_id = :owner AND c\.status = \x27ACTIVE\x27/AND r.creation_id = :world AND c.status = \x27ACTIVE\x27/'
mutate "W3 another owner's world renamed" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/WHERE id = :id AND owner_id = :owner AND status = \x27ACTIVE\x27 AND row_version = :expected/WHERE id = :id AND status = \x27ACTIVE\x27 AND row_version = :expected/'
mutate "W3 a key's other body answered as the first" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(!op\.requestHash\(\)\.equals\(s\.requestHash\(\)\)\) \{/if (false) {/'
mutate "W3 past an account's worlds" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(worlds >= limits\.maxWorlds\(\)\) \{/if (false) {/'
mutate "W3 past an account's bytes" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(account\.used\(\) \+ account\.reserved\(\) \+ s\.bytes\(\) > limits\.maxBytes\(\)\) \{/if (false) {/'
mutate "W3 a failed write's bytes given back as used ones" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/String counter = object\.charge\(\)\.equals\("USED"\) \? "used" : "reserved";/String counter = "used";/'
mutate "W3 a third save under way" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/if \(pending >= limits\.pendingSaves\(\)\) \{/if (false) {/'
mutate "W3 a dead save left running" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/AND route LIKE \x27POST %\x27 AND updated_at < :before/AND route LIKE \x27POST %\x27 AND updated_at < :before AND 1 = 0/'
mutate "W3 a deleted world's bytes kept" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/for \(String object : objects\) \{\n\s*queueDeletion\(object, now\);/for (String object : objects) {/'
mutate "W3 an old head kept" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/\n\s*queueDeletion\(oldObject, save\.now\(\)\);//'
mutate "W3 a conflicted save's bytes kept" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/\n\s*queueDeletion\(started\.objectId\(\), save\.now\(\)\);(\n\s*finish\(started\.operationId\(\), ErrorCode\.CONFLICT)/$1/'
mutate "W3 a missing or altered object served" "$P/world/Worlds.java" platform-service WorldRoutesTest \
    's/if \(bytes == null \|\| bytes\.length != r\.head\(\)\.bytes\(\) \|\| !WorldCheck\.sha256\(bytes\)\.equals\(r\.head\(\)\.sha256\(\)\)\) \{/if (bytes == null) {/'
mutate "W3 an inactive account's world saved" "$P/world/Worlds.java" platform-service WorldRoutesTest \
    's/if \(account\.status\(\) != Account\.Status\.ACTIVE\) \{/if (false) {/'
mutate "W3 a control character in a title" "$P/world/Worlds.java" platform-service WorldRoutesTest \
    's/if \(title\.codePoints\(\)\.anyMatch\(c -> Character\.getType\(c\) == Character\.CONTROL\)\) \{/if (false) {/'
mutate "W3 a save without its key" "$P/world/Worlds.java" platform-service WorldRoutesTest \
    's/if \(key == null \|\| !KEY\.matcher\(key\)\.matches\(\)\) \{/if (false) {/'
mutate "W3 bytes given back before B2 confirms" "$P/world/CleanupWorker.java" platform-service WorldRoutesTest \
    's/\} catch \(ObjectStore\.StorageUnavailable e\) \{\n(\s*)return false;/} catch (ObjectStore.StorageUnavailable e) {\n${1}store.objectDeleted(job, token, object, now);\n${1}return true;/'
mutate "W3 one key, two saves" "$V" platform-service WorldRoutesTest \
    's/\n\s*UNIQUE KEY operation_key \(owner_id, route, idempotency_key\),//'
mutate "W3 a running operation's status read as 0" "$P/world/JdbcWorldStore.java" platform-service WorldRoutesTest \
    's/Integer status = row\.wasNull\(\) \? null : raw;/Integer status = raw;/'
mutate "W3 a public assets bucket taken for the private one" "$P/storage/StorageConfiguration.java" platform-service StorageConfigurationTest \
    's/if \(PUBLIC_BUCKETS\.contains\(properties\.bucket\(\)\.trim\(\)\)\) \{/if (false) {/'
mutate "W3 the assets bucket's endpoint read for the private one" platform-service/src/main/resources/application.yaml platform-service StorageConfigurationTest \
    's/endpoint: \$\{B2_PRIVATE_ENDPOINT:\}/endpoint: \${B2_ENDPOINT:}/'
mutate "W3 the assets bucket's region read for the private one" platform-service/src/main/resources/application.yaml platform-service StorageConfigurationTest \
    's/region: \$\{B2_PRIVATE_REGION:\}/region: \${B2_REGION:}/'
}

PREFLIGHT=1
mutations
PREFLIGHT=""
if [ "$missing" -gt 0 ]; then
    echo "preflight: $missing missing file(s) or test class(es); nothing was mutated. Retarget or delete those entries."
    exit 2
fi
mutations

echo "$ran mutation(s)${DRY:+, a dry run}"
exit $status
