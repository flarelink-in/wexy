package ai.wexy.forge.agent;

import ai.wexy.forge.engine.EngineBundle;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * EA-U3 (the agent-loop design §7, §12): the documentation tools answer exactly and deterministically from the
 * embedded bundle, refuse what is not in it with a hint the model can act on, and hold the round's and the turn's
 * caps, saying so when they cut or refuse. Nothing but the bundle is ever read.
 */
class AgentToolsTest {

    static final EngineBundle BUNDLE = EngineBundle.load(new ObjectMapper());

    private final AgentTools tools = new AgentTools(BUNDLE);

    private static ToolBudget budget() {
        return new ToolBudget(6, 8, 65_536);
    }

    static ToolRequest read(String doc, Integer start, Integer count) {
        return new ToolRequest("read_doc", doc, null, null, null, start, count, "test");
    }

    static ToolRequest inspect(String symbol) {
        return new ToolRequest("inspect_api", null, symbol, null, null, null, null, "test");
    }

    static ToolRequest search(String query, String family) {
        return new ToolRequest("search_docs", null, null, query, family, null, null, "test");
    }

    static ToolRequest example(String doc) {
        return new ToolRequest("read_example", doc, null, null, null, null, null, "test");
    }

    private ToolResult one(ToolRequest request) {
        return tools.round(List.of(request), budget()).get(0);
    }

    @Test
    void readDocGivesTheExactLinesWithTheirRangeAndHash() {
        EngineBundle.Doc guide = BUNDLE.doc("agent/guide");
        String[] lines = guide.text().split("\n", -1);

        ToolResult r = one(read("agent/guide", 9, 3));

        assertThat(r.ok()).isTrue();
        assertThat(r.target()).isEqualTo("agent/guide");
        assertThat(r.text()).startsWith("<tool_result tool=\"read_doc\" doc=\"agent/guide\" sha256=\"" + guide.sha256()
                        + "\" lines=\"9-11 of " + lines.length + "\" truncated=\"false\">\n" + lines[8] + "\n" + lines[9] + "\n" + lines[10] + "\n")
                .endsWith("</tool_result>");
        assertThat(r.bytes()).isEqualTo(r.text().getBytes(java.nio.charset.StandardCharsets.UTF_8).length);

        ToolResult tail = one(read("agent/guide", lines.length - 1, 160));
        assertThat(tail.text()).contains("lines=\"" + (lines.length - 1) + "-" + lines.length + " of " + lines.length + "\" truncated=\"true\"");
    }

    @Test
    void aBadReadIsAToolErrorTheModelCanActOn() {
        assertThat(one(read("agent/guide", 0, 5)).error()).contains("has lines 1 to");
        assertThat(one(read("agent/guide", 1, 161)).error()).contains("1 to 160 lines");
        assertThat(one(read("api/nope", 1, 5)).error()).contains("no document \"api/nope\"");
        assertThat(one(read(null, 1, 5)).error()).contains("read_doc needs a docId");
        // A path or a URL is only an id the bundle does not have: nothing outside it is ever read.
        assertThat(one(read("../../etc/passwd", 1, 5)).error()).contains("no document \"../../etc/passwd\"");
        assertThat(one(read("https://example.com/docs.md", 1, 5)).error()).contains("no document");
        assertThat(one(read("post", 1, 5)).error()).contains("api/post");
        assertThat(one(read("agent/nope", 1, 5)).ok()).isFalse();
        assertThat(one(read("agent/nope", 1, 5)).text()).startsWith("<tool_error tool=\"read_doc\" target=\"agent/nope\">");
    }

    @Test
    void inspectApiGivesTheDeclarationTheDocumentsAndTheSupport() {
        ToolResult r = one(inspect("core:NullGraph"));

        assertThat(r.ok()).isTrue();
        assertThat(r.text()).contains("symbol=\"core:NullGraph\" kind=\"class\" family=\"core\" support=\"unverified\"")
                .contains("createBatch(pass: RenderPassNode, config: PipelineConfig)")
                .contains("Documents: ").contains("api/core");
        assertThat(one(inspect("materials:Materials")).error()).contains("no export materials:Materials");
        assertThat(one(inspect("core:PostChain")).error()).contains("PostChain is in post, not core");
        assertThat(one(inspect("shapes:Cube")).error()).contains("null-graph has no family shapes");
        assertThat(one(inspect("NullGraph")).error()).contains("core:NullGraph");
        // A host family's export answers, marked unsupported (the frontend's EA-H).
        assertThat(one(inspect("film:BATCH_FRAMES")).text()).contains("support=\"unsupported\"");
    }

    @Test
    void searchFindsRankedExcerptsAndIsDeterministic() {
        ToolResult a = one(search("FilmGrain intensity", "post"));
        ToolResult b = one(search("FilmGrain intensity", "post"));

        assertThat(a.ok()).isTrue();
        assertThat(a.text()).isEqualTo(b.text()).contains("--- api/post lines ");
        String[] hits = a.text().substring(0, a.text().lastIndexOf("\n</tool_result>")).split("\n--- ");
        assertThat(hits.length - 1).isBetween(1, 8);
        for (int i = 1; i < hits.length; i++) {
            assertThat(hits[i].split("\n").length - 1).isLessThanOrEqualTo(12);
        }
        assertThat(one(search("zzqqxxvv", null)).text()).contains("hits=\"0\"");
        assertThat(one(search("a", null)).error()).contains("2 to 120 characters");
        assertThat(one(search("!!", null)).error()).contains("a word of two letters or more");
        assertThat(one(search("fog", "weather")).error()).contains("null-graph has no family weather");
    }

    @Test
    void readExampleGivesAWholeExampleAndNothingElse() {
        EngineBundle.Doc instancing = BUNDLE.doc("example/instancing");

        assertThat(one(example("example/instancing")).text()).contains(instancing.text().strip());
        assertThat(one(example("api/core")).error()).contains("not an example");
    }

    @Test
    void anUnknownToolIsAnErrorThatNamesTheTools() {
        ToolResult r = one(new ToolRequest("fetch_url", null, null, "https://example.com", null, null, null, "test"));

        assertThat(r.ok()).isFalse();
        assertThat(r.error()).contains("no tool fetch_url").contains("read_doc, inspect_api, search_docs, read_example");
    }

    @Test
    void theRoundAndTheTurnCapsHoldAndSaySo() {
        ToolBudget budget = budget();
        List<ToolRequest> seven = IntStream.range(0, 7).mapToObj(i -> read("agent/guide", 1 + i, 2)).toList();

        List<ToolResult> first = tools.round(seven, budget);

        assertThat(first).hasSize(7);
        assertThat(first.subList(0, 6)).allMatch(ToolResult::ok);
        assertThat(first.get(6).error()).contains("at most 6 requests a round");
        assertThat(budget.requestsLeft()).isEqualTo(2);

        List<ToolResult> second = tools.round(List.of(read("api/core", 1, 2), read("api/core", 3, 2), read("api/core", 5, 2)), budget);
        assertThat(second.subList(0, 2)).allMatch(ToolResult::ok);
        assertThat(second.get(2).error()).contains("8 requests a turn");
        assertThat(budget.requestsLeft()).isZero();
    }

    @Test
    void theDocumentBytesCapCutsAResultThenRefusesTheNext() {
        ToolBudget small = new ToolBudget(6, 8, 2_000);

        ToolResult cut = tools.round(List.of(read("api/post", 1, 160)), small).get(0);

        assertThat(cut.ok()).isTrue();
        assertThat(cut.bytes()).isLessThanOrEqualTo(2_000);
        assertThat(cut.text()).contains("cut=\"the turn's 2000 bytes of documents ran out after line ").endsWith("</tool_result>");
        assertThat(small.bytesLeft()).isLessThan(400);
        assertThat(tools.round(List.of(read("api/core", 1, 40)), small).get(0).error()).contains("bytes of documents are spent");
    }

    static int utf8(String text) {
        return text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    // Gate A (agent-loop design §15.1): the review of EA2.1.

    @Test
    void anOversizedInvalidIdIsRefusedInABoundedError() {
        String huge = "x".repeat(10_000);

        ToolResult read = one(read(huge, 1, 5));
        ToolResult inspect = one(inspect("core:" + huge));

        assertThat(read.ok()).isFalse();
        assertThat(utf8(read.text())).isLessThanOrEqualTo(400);
        assertThat(read.error()).contains("10000 characters");
        assertThat(utf8(inspect.text())).isLessThanOrEqualTo(400);
    }

    @Test
    void errorsStayBoundedAfterTheCapsAndTheCountersNeverGoBelowZero() {
        ToolBudget budget = new ToolBudget(6, 2, 2_000);
        tools.round(List.of(read("api/post", 1, 160), read("api/core", 1, 40)), budget);
        List<ToolRequest> many = IntStream.range(0, 40).mapToObj(i -> read("nope/" + "y".repeat(50) + i, 1, 1)).toList();

        List<ToolResult> results = tools.round(many, budget);

        assertThat(results).hasSize(40).noneMatch(ToolResult::ok);
        assertThat(results.stream().mapToInt(r -> utf8(r.text())).sum()).isLessThanOrEqualTo(4_096);
        // Past the round's cap the rest share one block, rather than one each.
        assertThat(results.subList(6, 40)).filteredOn(r -> !r.text().isEmpty()).hasSize(1);
        assertThat(budget.requestsLeft()).isZero();
        assertThat(budget.bytesLeft()).isNotNegative();
    }

    @Test
    void bytesAreCountedInUtf8() {
        ToolResult r = one(read("api/agent-grid", 1, 3));

        assertThat(r.bytes()).isEqualTo(utf8(r.text())).isGreaterThan(r.text().length());
    }

    @Test
    void aCutReadSaysWhichLinesItReturnedAndThatItWasCut() {
        ToolBudget small = new ToolBudget(6, 8, 2_000);

        ToolResult cut = tools.round(List.of(read("api/post", 1, 160)), small).get(0);

        java.util.regex.Matcher m = java.util.regex.Pattern.compile("lines=\"1-(\\d+) of \\d+\" truncated=\"true\"").matcher(cut.text());
        assertThat(m.find()).as(cut.text().substring(0, 200)).isTrue();
        int last = Integer.parseInt(m.group(1));
        String body = cut.text().substring(cut.text().indexOf(">\n") + 2, cut.text().lastIndexOf("</tool_result>"));
        assertThat(body.split("\n", -1).length - 1).isEqualTo(last);
        assertThat(cut.text()).contains("cut=\"the turn's 2000 bytes of documents ran out after line " + last + "\"");
        assertThat(cut.bytes()).isLessThanOrEqualTo(2_000);
    }

    @Test
    void searchWindowsNeverOverlap() {
        for (String query : List.of("light shadow", "batch instance", "bind group")) {
            ToolResult r = one(search(query, null));
            java.util.Map<String, List<int[]>> windows = new java.util.HashMap<>();
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("--- (\\S+) lines (\\d+)-(\\d+)").matcher(r.text());
            while (m.find()) {
                windows.computeIfAbsent(m.group(1), k -> new java.util.ArrayList<>())
                        .add(new int[] {Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))});
            }
            for (List<int[]> list : windows.values()) {
                list.sort(java.util.Comparator.comparingInt(w -> w[0]));
                for (int i = 1; i < list.size(); i++) {
                    assertThat(list.get(i)[0]).as(query).isGreaterThan(list.get(i - 1)[1]);
                }
            }
        }
    }

    @Test
    void theToolsReadNothingButTheBundle() throws Exception {
        // A structural guard (A3): the agent package imports no file, network or process API.
        try (var files = Files.list(Path.of("src/main/java/ai/wexy/forge/agent"))) {
            for (Path source : files.toList()) {
                assertThat(Files.readString(source)).as(source.toString())
                        .doesNotContain("java.io.File").doesNotContain("java.nio.file").doesNotContain("java.net.")
                        .doesNotContain("ProcessBuilder").doesNotContain("Runtime.getRuntime").doesNotContain("WebClient");
            }
        }
    }
}
