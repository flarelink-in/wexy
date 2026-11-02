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
status=0
ran=0
index=0

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
    local before
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

# B0.3 (forge-loop design §12, M4): dev tokens must not exist outside the local profile. The @ is
# escaped since 2026-10-31: unescaped, Perl read it as an empty array and the mutation left a bare
# @Profile, which does not compile, so this was "caught" without the profile test ever running.
mutate "dev tokens outside local" "$G/auth/DevTokenVerifier.java" forge-gateway DevTokenVerifierProfileTest \
    's/\@Profile\("local"\)\n//'

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
mutate "trailing text after a config read as JSON" "$S/agent/NodeCheck.java" forge-service NodeCheckTest \
    's/new ObjectMapper\(\)\.enable\(DeserializationFeature\.FAIL_ON_TRAILING_TOKENS\)/new ObjectMapper()/'
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

echo "$ran mutation(s)${DRY:+, a dry run}"
exit $status
