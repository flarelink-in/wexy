package ai.wexy.forge.agent;

import ai.wexy.forge.engine.EngineBundle;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.IntFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The agent's documentation tools (the agent-loop design §7, EA2.1): {@code read_doc}, {@code inspect_api},
 * {@code search_docs} and {@code read_example}, answered from the verified engine bundle and from nothing else (A3).
 * A request names ids the bundle has, never paths or URLs, so a path or a URL is only an unknown id: a tool error the
 * model reads, with a hint at the naming. Every answer is deterministic.
 *
 * <p>Everything a round returns is bounded (gate A of §15.1). A result counts against the turn's document bytes; one
 * that would pass them is cut after the last whole line that fits, and its tag then names the lines it returned, says
 * it was truncated, and why. Once fewer than {@value #MIN_RESULT_BYTES} bytes are left a read is refused. An error is
 * at most {@value #MAX_ERROR_BYTES} bytes, echoes at most {@value #MAX_ECHO} characters of what it was sent, and is
 * charged to the turn's error allowance; past that allowance it carries no detail. Requests past a round's cap share
 * one error.
 */
public final class AgentTools {

    public static final List<String> TOOLS = List.of("read_doc", "inspect_api", "search_docs", "read_example");
    static final int READ_LIMIT = 160;
    static final int SEARCH_HITS = 8;
    static final int EXCERPT_LINES = 12;
    static final int DECLARATION_BYTES = 8192;
    static final int MIN_RESULT_BYTES = 512;
    /** The most bytes one error block may take, whatever it was sent. */
    public static final int MAX_ERROR_BYTES = 400;
    /** The most characters of a request's own text an error repeats back. */
    static final int MAX_ECHO = 60;
    private static final String CLOSE = "</tool_result>";
    private static final Pattern WORD = Pattern.compile("[a-z0-9_]{2,}");

    private final EngineBundle bundle;
    /** Each document's lines, split once (the texts are LF, as the frontend counts them). */
    private final Map<String, String[]> lines = new HashMap<>();

    public AgentTools(EngineBundle bundle) {
        this.bundle = bundle;
        for (EngineBundle.Doc d : bundle.docs().values()) {
            lines.put(d.id(), d.text().split("\n", -1));
        }
    }

    /**
     * One {@code need_context} round, one result a request, in order: the first {@code perRound} run while the turn has
     * requests left, and each of the others is refused. A request that runs counts against the turn whether it answers
     * or is refused for its arguments. The requests past the round's cap share one error, carried by the first of them.
     */
    public List<ToolResult> round(List<ToolRequest> requests, ToolBudget budget) {
        List<ToolResult> results = new ArrayList<>();
        for (int i = 0; i < requests.size(); i++) {
            ToolRequest request = requests.get(i);
            if (i == budget.perRound()) {
                results.add(error(request, "at most " + budget.perRound() + " requests a round run; requests " + (i + 1) + " to "
                        + requests.size() + " did not", budget));
            } else if (i > budget.perRound()) {
                results.add(silent(request, "past the round's cap"));
            } else if (budget.requestsLeft() <= 0) {
                results.add(error(request, "the turn allows " + budget.maxRequests() + " requests a turn, and all are used: "
                        + "plan with what you have", budget));
            } else {
                budget.request();
                results.add(run(request, budget));
            }
        }
        return results;
    }

    private ToolResult run(ToolRequest r, ToolBudget budget) {
        String tool = r.tool() == null ? "" : r.tool();
        return switch (tool) {
            case "read_doc" -> readDoc(r, budget);
            case "inspect_api" -> inspectApi(r, budget);
            case "search_docs" -> searchDocs(r, budget);
            case "read_example" -> readExample(r, budget);
            default -> error(r, "no tool " + (tool.isBlank() ? "(none was named)" : shown(tool)) + "; the tools are "
                    + String.join(", ", TOOLS), budget);
        };
    }

    private ToolResult readDoc(ToolRequest r, ToolBudget budget) {
        if (blank(r.docId())) {
            return error(r, "read_doc needs a docId, like api/post", budget);
        }
        EngineBundle.Doc doc = bundle.docs().get(r.docId());
        if (doc == null) {
            return error(r, unknownDoc(r.docId()), budget);
        }
        String[] all = lines.get(doc.id());
        int start = r.startLine() == null ? 1 : r.startLine();
        int count = r.lineCount() == null ? READ_LIMIT : r.lineCount();
        if (count < 1 || count > READ_LIMIT) {
            return error(r, "a read is 1 to " + READ_LIMIT + " lines, not " + count, budget);
        }
        if (start < 1 || start > all.length) {
            return error(r, doc.id() + " has lines 1 to " + all.length + "; " + start + " is outside them", budget);
        }
        int end = Math.min(all.length, start + count - 1);
        int asked = start + count - 1;
        // The tag names the lines actually returned, so a cut read never claims more than it holds.
        IntFunction<String> head = last -> "<tool_result tool=\"read_doc\" doc=\"" + doc.id() + "\" sha256=\"" + doc.sha256()
                + "\" lines=\"" + start + "-" + last + " of " + all.length + "\" truncated=\"" + (last < asked) + "\"";
        return block(r, doc.id(), head, List.of(all).subList(start - 1, end), start, budget);
    }

    private ToolResult inspectApi(ToolRequest r, ToolBudget budget) {
        if (blank(r.symbolId())) {
            return error(r, "inspect_api needs a symbolId, like core:NullGraph", budget);
        }
        EngineBundle.Symbol s = bundle.symbols().get(r.symbolId());
        if (s == null) {
            return error(r, unknownSymbol(r.symbolId()), budget);
        }
        EngineBundle.Support support = bundle.support(s.family());
        String declaration = s.declaration();
        String cut = "";
        if (bytes(declaration) > DECLARATION_BYTES) {
            declaration = cutAtLine(declaration, DECLARATION_BYTES);
            cut = " declaration-cut=\"the first " + bytes(declaration) + " bytes of " + bytes(s.declaration()) + "\"";
        }
        List<String> body = new ArrayList<>();
        body.add("Summary: " + (s.summary().isBlank() ? "(no doc comment)" : s.summary()));
        body.add("Documents: " + (s.docIds().isEmpty() ? "(none name it)" : String.join(", ", s.docIds())));
        body.add("Support: " + support.status() + ": " + support.reason());
        body.add("Declaration:");
        body.addAll(List.of(declaration.split("\n", -1)));
        String head = "<tool_result tool=\"inspect_api\" symbol=\"" + s.id() + "\" kind=\"" + s.kind() + "\" family=\""
                + s.family() + "\" support=\"" + support.status() + "\"" + cut;
        return block(r, s.id(), last -> head, body, 1, budget);
    }

    /** One line's place and score: how many of the query's words it holds. */
    private record Hit(int doc, int line, int score) {
    }

    private ToolResult searchDocs(ToolRequest r, ToolBudget budget) {
        String query = r.query() == null ? "" : r.query().strip();
        if (query.length() < 2 || query.length() > 120) {
            return error(r, "a search query is 2 to 120 characters, not " + query.length(), budget);
        }
        Set<String> words = new LinkedHashSet<>();
        Matcher m = WORD.matcher(query.toLowerCase(Locale.ROOT));
        while (m.find()) {
            words.add(m.group());
        }
        if (words.isEmpty()) {
            return error(r, "a search needs a word of two letters or more", budget);
        }
        List<EngineBundle.Doc> scope;
        if (blank(r.family())) {
            scope = List.copyOf(bundle.docs().values());
        } else {
            EngineBundle.Family family = bundle.families().get(r.family());
            if (family == null) {
                return error(r, "null-graph has no family " + shown(r.family()) + "; the families are "
                        + String.join(", ", bundle.families().keySet()), budget);
            }
            scope = Stream.concat(family.docs().stream(), family.examples().stream()).distinct()
                    .map(bundle.docs()::get).filter(Objects::nonNull).toList();
        }

        List<Hit> found = new ArrayList<>();
        for (int d = 0; d < scope.size(); d++) {
            String[] text = lines.get(scope.get(d).id());
            for (int i = 0; i < text.length; i++) {
                String lower = text[i].toLowerCase(Locale.ROOT);
                int score = 0;
                for (String word : words) {
                    score += lower.contains(word) ? 1 : 0;
                }
                if (score > 0) {
                    found.add(new Hit(d, i + 1, score));
                }
            }
        }
        // The best lines first; ties in the bundle's order. Each hit shows a window from two lines above its line,
        // clipped where it would run into a window already chosen, so no line is shown twice.
        found.sort(Comparator.comparingInt((Hit h) -> -h.score()).thenComparingInt(Hit::doc).thenComparingInt(Hit::line));
        List<int[]> windows = new ArrayList<>();
        for (Hit h : found) {
            if (windows.size() == SEARCH_HITS) {
                break;
            }
            if (windows.stream().anyMatch(w -> w[0] == h.doc() && h.line() >= w[1] && h.line() <= w[2])) {
                continue;
            }
            int from = Math.max(1, h.line() - 2);
            int to = Math.min(lines.get(scope.get(h.doc()).id()).length, from + EXCERPT_LINES - 1);
            for (int[] w : windows) {
                if (w[0] == h.doc() && from <= w[2] && to >= w[1]) {
                    if (h.line() < w[1]) {
                        to = w[1] - 1;
                    } else {
                        from = w[2] + 1;
                    }
                }
            }
            windows.add(new int[] {h.doc(), from, to});
        }
        List<String> body = new ArrayList<>();
        for (int[] w : windows) {
            EngineBundle.Doc doc = scope.get(w[0]);
            body.add("--- " + doc.id() + " lines " + w[1] + "-" + w[2] + " (sha256 " + doc.sha256().substring(0, 12) + ")");
            body.addAll(List.of(lines.get(doc.id())).subList(w[1] - 1, w[2]));
        }
        String head = "<tool_result tool=\"search_docs\" query=\"" + attribute(query) + "\""
                + (blank(r.family()) ? "" : " family=\"" + attribute(r.family()) + "\"") + " hits=\"" + windows.size() + "\"";
        return block(r, query, last -> head, body, 1, budget);
    }

    private ToolResult readExample(ToolRequest r, ToolBudget budget) {
        if (blank(r.docId())) {
            return error(r, "read_example needs a docId, like example/instancing", budget);
        }
        List<String> examples = bundle.docs().keySet().stream().filter(id -> id.startsWith("example/")).toList();
        if (!r.docId().startsWith("example/")) {
            return error(r, shown(r.docId()) + " is not an example; the examples are " + String.join(", ", examples)
                    + " (read_doc reads the rest)", budget);
        }
        EngineBundle.Doc doc = bundle.docs().get(r.docId());
        if (doc == null) {
            return error(r, unknownDoc(r.docId()), budget);
        }
        String[] all = lines.get(doc.id());
        IntFunction<String> head = last -> "<tool_result tool=\"read_example\" doc=\"" + doc.id() + "\" sha256=\"" + doc.sha256()
                + "\" lines=\"1-" + last + " of " + all.length + "\" truncated=\"" + (last < all.length) + "\"";
        return block(r, doc.id(), head, List.of(all), 1, budget);
    }

    /**
     * The lines under their opening tag, which {@code head} writes for the last line returned (numbered from
     * {@code firstLine}): whole when the block fits the turn's document bytes; else cut after the last whole line
     * that fits, the tag naming that line and why; refused when fewer than {@value #MIN_RESULT_BYTES} bytes are left,
     * or not one line fits. What it takes never passes what is left.
     */
    private ToolResult block(ToolRequest r, String target, IntFunction<String> head, List<String> body, int firstLine,
                             ToolBudget budget) {
        int left = budget.bytesLeft();
        if (left < MIN_RESULT_BYTES) {
            return error(r, spent(budget), budget);
        }
        int lastLine = firstLine + body.size() - 1;
        StringBuilder whole = new StringBuilder(head.apply(lastLine)).append(">\n");
        for (String line : body) {
            whole.append(line).append('\n');
        }
        whole.append(CLOSE);
        int wholeBytes = bytes(whole.toString());
        if (wholeBytes <= left) {
            budget.spend(wholeBytes);
            return new ToolResult(r.tool(), target, true, null, wholeBytes, whole.toString());
        }
        // Room for the lines: what is left less the longest tag and note this block could carry.
        int room = left - bytes(head.apply(lastLine)) - bytes(cutNote(budget, lastLine)) - bytes(">\n") - bytes(CLOSE);
        StringBuilder kept = new StringBuilder();
        int shown = 0;
        for (String line : body) {
            int b = bytes(line) + 1;
            if (b > room) {
                break;
            }
            kept.append(line).append('\n');
            room -= b;
            shown++;
        }
        if (shown == 0) {
            return error(r, spent(budget), budget);
        }
        int last = firstLine + shown - 1;
        String text = head.apply(last) + cutNote(budget, last) + ">\n" + kept + CLOSE;
        int n = bytes(text);
        budget.spend(n);
        return new ToolResult(r.tool(), target, true, null, n, text);
    }

    private static String cutNote(ToolBudget budget, int lastShown) {
        return " cut=\"the turn's " + budget.maxBytes() + " bytes of documents ran out after line " + lastShown + "\"";
    }

    private static String spent(ToolBudget budget) {
        return "the turn's " + budget.maxBytes() + " bytes of documents are spent: plan with what you have";
    }

    private String unknownDoc(String id) {
        List<String> near = id.length() > MAX_ECHO ? List.of() : bundle.docs().keySet().stream()
                .filter(d -> d.endsWith("/" + id) || (id.length() >= 3 && !id.contains("/") && d.contains(id))).limit(3).toList();
        return "no document \"" + shown(id) + "\" in the bundle; documents are named like agent/guide, api/post and example/instancing"
                + (near.isEmpty() ? "" : "; perhaps " + String.join(", ", near));
    }

    private String unknownSymbol(String id) {
        return id.length() > 120 ? "no export " + shown(id) + "; a symbol is named family:Name, like core:NullGraph"
                : Declarations.unknownSymbol(bundle, id);
    }

    /**
     * A refusal the model reads, bounded: its target and message shortened so the block is at most
     * {@value #MAX_ERROR_BYTES} bytes, then charged to the turn's error allowance. Past that allowance it carries
     * no detail for the model, though the turn's event still records why.
     */
    private static ToolResult error(ToolRequest r, String message, ToolBudget budget) {
        String tool = r.tool() == null ? "" : shown(r.tool());
        String target = shown(Stream.of(r.docId(), r.symbolId(), r.query()).filter(v -> !blank(v)).findFirst().orElse(""));
        // Escaping can grow an echo (a quote is six bytes), so the attributes are capped in bytes, whole entities only.
        String open = "<tool_error tool=\"" + attribute(tool, 60) + "\" target=\"" + attribute(target, 160) + "\">";
        String close = "</tool_error>";
        String detail = message.replace("<", "&lt;");
        int room = MAX_ERROR_BYTES - bytes(open) - bytes(close);
        if (bytes(detail) > room) {
            detail = cutToBytes(detail, room - 3) + "...";
        }
        String text = open + detail + close;
        return new ToolResult(tool, target, false, message, 0, budget.chargeError(bytes(text)) ? text : "");
    }

    /** A refusal the round counts but does not repeat to the model (one error already speaks for it). */
    private static ToolResult silent(ToolRequest r, String why) {
        String target = shown(Stream.of(r.docId(), r.symbolId(), r.query()).filter(v -> !blank(v)).findFirst().orElse(""));
        return new ToolResult(r.tool() == null ? "" : shown(r.tool()), target, false, why, 0, "");
    }

    /** What an error repeats of a request's own text: at most {@value #MAX_ECHO} characters, and the length when cut. */
    static String shown(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= MAX_ECHO ? text : text.substring(0, MAX_ECHO) + "... (" + text.length() + " characters)";
    }

    private static String cutAtLine(String text, int maxBytes) {
        StringBuilder out = new StringBuilder();
        for (String line : text.split("\n", -1)) {
            if (bytes(out.toString()) + bytes(line) + 1 > maxBytes) {
                break;
            }
            out.append(line).append('\n');
        }
        return out.toString().stripTrailing();
    }

    /** The longest prefix of {@code text} within {@code maxBytes} of UTF-8, never splitting a character. */
    private static String cutToBytes(String text, int maxBytes) {
        StringBuilder out = new StringBuilder();
        int used = 0;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            int n = bytes(new String(Character.toChars(cp)));
            if (used + n > maxBytes) {
                break;
            }
            out.appendCodePoint(cp);
            used += n;
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    /** A value inside an attribute: quotes, angle brackets and line breaks escaped. */
    private static String attribute(String value) {
        return attribute(value, Integer.MAX_VALUE);
    }

    /** The same, within {@code maxBytes}: escaped a character at a time, so a cut never splits an entity. */
    private static String attribute(String value, int maxBytes) {
        StringBuilder out = new StringBuilder();
        int used = 0;
        for (int i = 0; i < value.length(); ) {
            int cp = value.codePointAt(i);
            String escaped = switch (cp) {
                case '&' -> "&amp;";
                case '"' -> "&quot;";
                case '<' -> "&lt;";
                case '>' -> "&gt;";
                case '\n' -> " ";
                default -> new String(Character.toChars(cp));
            };
            int n = bytes(escaped);
            if (used + n > maxBytes) {
                break;
            }
            out.append(escaped);
            used += n;
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static int bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }
}
