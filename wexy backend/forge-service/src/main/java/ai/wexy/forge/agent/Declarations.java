package ai.wexy.forge.agent;

import ai.wexy.forge.engine.EngineBundle;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What K's declarations say about a call and an options type, read from the declarations as written (the agent-loop
 * design §8): the parameters of a constructor, a function or a method, its overloads merged, and the properties of an
 * interface or an object type alias, with those of what it extends. Comments are dropped first, so prose that names a
 * method is never read as its signature. A null answer means the declaration does not show it (a static typed
 * {@code typeof createCube}, an options type the package does not export, an index signature): nothing is checked
 * there, rather than a guess.
 */
final class Declarations {

    record Param(String name, String type, boolean optional) {
    }

    record Property(String name, String type, boolean optional) {
    }

    private static final Pattern COMMENT = Pattern.compile("(?s)/\\*.*?\\*/|//[^\\n]*");
    private static final Pattern PARAM = Pattern.compile("(?s)^(?:\\.\\.\\.)?([A-Za-z_$][\\w$]*)(\\??)\\s*:\\s*(.*)$");
    private static final Pattern PROPERTY = Pattern.compile("(?s)^(?:readonly\\s+)?([A-Za-z_$][\\w$]*)(\\??)\\s*(?::\\s*(.*)|\\(.*)$");
    private static final Pattern NAME = Pattern.compile("[A-Za-z_$][\\w$]*");

    private final EngineBundle bundle;
    private final Map<String, EngineBundle.Symbol> byName = new HashMap<>();

    Declarations(EngineBundle bundle) {
        this.bundle = bundle;
        for (EngineBundle.Symbol s : bundle.symbols().values()) {
            byName.putIfAbsent(s.name(), s);
        }
    }

    /** A declaration without its comments. */
    static String code(String declaration) {
        return COMMENT.matcher(declaration).replaceAll("");
    }

    /** Whether an export declares {@code member}: a method, a property or an accessor. */
    static boolean declaresMember(EngineBundle.Symbol symbol, String member) {
        return Pattern.compile("(^|[\\s;{(,])(?:readonly\\s+|static\\s+|get\\s+|set\\s+|async\\s+)*" + Pattern.quote(member) + "\\s*[(<:?!]",
                Pattern.MULTILINE).matcher(code(symbol.declaration())).find();
    }

    /**
     * The parameters of a call, by name and in order: the class's constructor when {@code member} is null, the
     * function itself, or the method. A parameter that one overload lacks is optional. Null when no signature shows.
     */
    Map<String, Param> params(EngineBundle.Symbol symbol, String member) {
        String text = code(symbol.declaration());
        String name = member != null ? member : "class".equals(symbol.kind()) ? "constructor" : symbol.name();
        Matcher m = Pattern.compile("(?:^|[\\s;{(,])(?:static\\s+|readonly\\s+|async\\s+|function\\s+)*" + Pattern.quote(name)
                + "\\s*(?:<[^>]*>)?\\s*\\(", Pattern.MULTILINE).matcher(text);
        List<Map<String, Param>> overloads = new ArrayList<>();
        while (m.find()) {
            Map<String, Param> one = new LinkedHashMap<>();
            for (String part : splitTop(balanced(text, m.end()), ",")) {
                Matcher p = PARAM.matcher(part.strip());
                if (p.matches()) {
                    one.put(p.group(1), new Param(p.group(1), p.group(3).strip(), !p.group(2).isEmpty()));
                }
            }
            overloads.add(one);
        }
        if (overloads.isEmpty()) {
            return null;
        }
        Map<String, Param> merged = new LinkedHashMap<>();
        for (Map<String, Param> one : overloads) {
            for (Param p : one.values()) {
                boolean everywhere = overloads.stream().allMatch(o -> o.containsKey(p.name()));
                merged.merge(p.name(), new Param(p.name(), p.type(), p.optional() || !everywhere),
                        (a, b) -> new Param(a.name(), a.type(), a.optional() || b.optional()));
            }
        }
        return merged;
    }

    /**
     * The properties of an options type, by name: an interface or an object type alias that K has, with what it
     * extends. Null when the type is anything else, or takes any key, or extends a type K does not show.
     */
    Map<String, Property> properties(String typeText) {
        String type = typeText.replace("| undefined", "").strip();
        if (!NAME.matcher(type).matches()) {
            return null;
        }
        EngineBundle.Symbol s = byName.get(type);
        if (s == null || !("interface".equals(s.kind()) || "type".equals(s.kind()))) {
            return null;
        }
        String text = code(s.declaration());
        int at = text.indexOf(type);
        int open = at < 0 ? -1 : text.indexOf('{', at);
        if (open < 0) {
            return null;
        }
        Map<String, Property> props = new LinkedHashMap<>();
        for (String member : splitTop(balanced(text, open + 1), ";\n")) {
            String m = member.strip();
            if (m.isEmpty()) {
                continue;
            }
            if (m.startsWith("[")) {
                return null;
            }
            Matcher p = PROPERTY.matcher(m);
            if (p.matches()) {
                props.put(p.group(1), new Property(p.group(1), p.group(3) == null ? "" : p.group(3).strip(), !p.group(2).isEmpty()));
            }
        }
        Matcher ext = Pattern.compile("interface\\s+" + Pattern.quote(type) + "\\s*(?:<[^{]*>)?\\s+extends\\s+([^{]+)\\{").matcher(text);
        if (ext.find()) {
            for (String parent : splitTop(ext.group(1), ",")) {
                Map<String, Property> inherited = properties(parent.replaceAll("<.*", "").strip());
                if (inherited == null) {
                    return null;
                }
                inherited.forEach(props::putIfAbsent);
            }
        }
        return props;
    }

    /** Why {@code id} is not an export, with a hint the model can act on (the tools and the check say the same). */
    static String unknownSymbol(EngineBundle bundle, String id) {
        int colon = id.indexOf(':');
        if (colon < 0) {
            List<String> named = bundle.symbols().values().stream().filter(s -> s.name().equals(id)).map(EngineBundle.Symbol::id).toList();
            return named.isEmpty() ? "a symbol is named family:Name, like core:NullGraph, and no export is named " + id
                    : "a symbol is named family:Name: " + String.join(" or ", named);
        }
        String family = id.substring(0, colon);
        String name = id.substring(colon + 1);
        if (!bundle.families().containsKey(family)) {
            return "null-graph has no family " + family + "; the families are " + String.join(", ", bundle.families().keySet());
        }
        List<String> elsewhere = bundle.symbols().values().stream().filter(s -> s.name().equals(name)).map(EngineBundle.Symbol::family).toList();
        return elsewhere.isEmpty() ? "no export " + id + " in null-graph " + bundle.engineVersion() + "; search_docs may find what you mean"
                : name + " is in " + String.join(" and ", elsewhere) + ", not " + family;
    }

    /** The text from {@code from} up to the bracket that closes the one just opened before it ({@code =>} is no bracket). */
    private static String balanced(String text, int from) {
        int depth = 1;
        int i = from;
        while (i < text.length() && depth > 0) {
            char c = text.charAt(i);
            boolean arrow = c == '>' && i > 0 && text.charAt(i - 1) == '=';
            if (c == '(' || c == '{' || c == '[' || c == '<') {
                depth++;
            } else if (!arrow && (c == ')' || c == '}' || c == ']' || c == '>')) {
                depth--;
            }
            i++;
        }
        return text.substring(from, Math.max(from, i - 1));
    }

    /** Splits at any of {@code separators} outside brackets, and outside the arrow of a function type. */
    private static List<String> splitTop(String text, String separators) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean arrow = c == '>' && i > 0 && text.charAt(i - 1) == '=';
            if (!arrow && (c == '(' || c == '{' || c == '[' || c == '<')) {
                depth++;
            } else if (!arrow && (c == ')' || c == '}' || c == ']' || c == '>')) {
                depth--;
            }
            if (depth == 0 && separators.indexOf(c) >= 0) {
                parts.add(current.toString());
                current.setLength(0);
            } else {
                current.append(c);
            }
        }
        if (!current.toString().isBlank()) {
            parts.add(current.toString());
        }
        return parts;
    }
}
