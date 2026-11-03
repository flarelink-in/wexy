package ai.wexy.platform.world;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Whether a text is canonical JSON exactly as the studio writes it (W3.1; the creations platform design §5, "Exact
 * bytes"): RFC 8785 for the JSON the browser's {@code canonicalJson} writes ({@code src/contract/adapters/canonical.ts}).
 * The platform stores the bytes it receives and never re-serializes them, so a save is accepted only when its text is
 * already the one its value writes: keys sorted by UTF-16 code units, no whitespace, strings escaped as
 * {@code JSON.stringify} escapes them, numbers in ECMAScript's shortest round-trip form ({@code Number::toString}), and
 * no value the browser would refuse to write: an integer past 2^53, a non-finite number, a duplicate key.
 *
 * <p>The text is parsed by a strict recursive-descent reader bounded at {@link #MAX_DEPTH}, so a deep text cannot
 * exhaust the stack, then written canonically and compared with itself. Not Jackson: its key order and number forms
 * differ from the browser's. Tested on the studio's saved-world corpus and on doubles Node formatted
 * ({@code test/fixtures/worlds/numbers.json}).
 */
public final class CanonicalText {

    /** Deeper than any saved world nests (a keyframe's target is five levels down); far below the stack's reach. */
    public static final int MAX_DEPTH = 32;

    /** 2^53: the browser refuses any integer from here up (it is no longer an exact one). */
    private static final double SAFE_LIMIT = 9007199254740992.0;

    private CanonicalText() {
    }

    /** Why `text` is not canonical JSON as the studio writes it, in a few words; null when it is. */
    public static String problem(String text) {
        Object value;
        try {
            Reader reader = new Reader(text);
            value = reader.value(0);
            reader.skipSpace();
            if (reader.at < text.length()) {
                return "text follows the value at " + reader.at;
            }
        } catch (NotJson e) {
            return e.getMessage();
        }
        StringBuilder out = new StringBuilder(text.length());
        try {
            write(value, out);
        } catch (NotJson e) {
            return e.getMessage();
        }
        if (!out.toString().equals(text)) {
            return "its bytes are not the ones its value writes (first difference at " + firstDifference(out, text) + ")";
        }
        return null;
    }

    /** Whether `text` is canonical. */
    public static boolean isCanonical(String text) {
        return problem(text) == null;
    }

    /** A double as ECMAScript's {@code Number::toString} writes it (and so {@code JSON.stringify}): -0 as 0. */
    public static String number(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) {
            throw new IllegalArgumentException(v + " is not a finite number");
        }
        if (v == 0) {
            return "0";
        }
        StringBuilder out = new StringBuilder(24);
        if (v < 0) {
            out.append('-');
            v = -v;
        }
        BigDecimal shortest = shortest(v).stripTrailingZeros();
        String digits = shortest.unscaledValue().toString();
        int k = digits.length();
        // v = digits × 10^(n − k), as the specification names them.
        int n = k - shortest.scale();
        if (k <= n && n <= 21) {
            out.append(digits).append("0".repeat(n - k));
        } else if (0 < n && n <= 21) {
            out.append(digits, 0, n).append('.').append(digits, n, k);
        } else if (-6 < n && n <= 0) {
            out.append("0.").append("0".repeat(-n)).append(digits);
        } else {
            int e = n - 1;
            out.append(digits.charAt(0));
            if (k > 1) {
                out.append('.').append(digits, 1, k);
            }
            out.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
        }
        return out.toString();
    }

    /**
     * The decimal ECMAScript writes for a positive finite double: the fewest significant digits that still read back as
     * {@code v}, and of two such, the one nearer {@code v}, then the one whose last digit is even (the specification's
     * recommended rule, which V8 follows). At each precision only the decimals just below and just above {@code v} can
     * be the nearest, so those two are tried, from one digit up.
     */
    private static BigDecimal shortest(double v) {
        BigDecimal exact = new BigDecimal(v);
        for (int p = 1; p <= 17; p++) {
            BigDecimal below = exact.round(new MathContext(p, RoundingMode.FLOOR));
            BigDecimal above = exact.round(new MathContext(p, RoundingMode.CEILING));
            boolean belowReads = Double.parseDouble(below.toString()) == v;
            boolean aboveReads = Double.parseDouble(above.toString()) == v;
            if (belowReads && aboveReads && below.compareTo(above) != 0) {
                int nearer = exact.subtract(below).compareTo(above.subtract(exact));
                if (nearer != 0) {
                    return nearer < 0 ? below : above;
                }
                return below.unscaledValue().testBit(0) ? above : below;
            }
            if (belowReads) {
                return below;
            }
            if (aboveReads) {
                return above;
            }
        }
        // Seventeen significant digits always read back (IEEE 754); unreachable.
        return exact.round(new MathContext(17, RoundingMode.HALF_EVEN));
    }

    private static void write(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof Boolean b) {
            out.append(b ? "true" : "false");
        } else if (value instanceof String s) {
            string(s, out);
        } else if (value instanceof Double d) {
            if (d == Math.rint(d) && Math.abs(d) >= SAFE_LIMIT) {
                throw new NotJson("an integer past 2^53, which the studio never writes");
            }
            out.append(number(d));
        } else if (value instanceof List<?> list) {
            out.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                write(list.get(i), out);
            }
            out.append(']');
        } else {
            @SuppressWarnings("unchecked")
            Map<String, Object> object = (Map<String, Object>) value;
            // String's own order is UTF-16 code units, as Array.prototype.sort leaves the browser's keys.
            Map<String, Object> sorted = new TreeMap<>(object);
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : sorted.entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                string(e.getKey(), out);
                out.append(':');
                write(e.getValue(), out);
            }
            out.append('}');
        }
    }

    /** A string as {@code JSON.stringify} writes it (ES2019's well-formed form: a lone surrogate escaped). */
    private static void string(String s, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        unicode(c, out);
                    } else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                        out.append(c).append(s.charAt(++i));
                    } else if (Character.isSurrogate(c)) {
                        unicode(c, out);
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static void unicode(char c, StringBuilder out) {
        out.append("\\u");
        String hex = Integer.toHexString(c);
        out.append("0".repeat(4 - hex.length())).append(hex);
    }

    private static int firstDifference(CharSequence a, CharSequence b) {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) {
            if (a.charAt(i) != b.charAt(i)) {
                return i;
            }
        }
        return n;
    }

    /** The text is not JSON, or holds a value the studio never writes. A message of a few words, never the text. */
    private static final class NotJson extends RuntimeException {
        NotJson(String message) {
            super(message, null, false, false);
        }
    }

    /** RFC 8259's grammar, strictly: no comments, no trailing commas, no single quotes, no leading zeros. */
    private static final class Reader {
        private final String text;
        private int at;

        Reader(String text) {
            this.text = text;
        }

        Object value(int depth) {
            if (depth > MAX_DEPTH) {
                throw new NotJson("nested deeper than " + MAX_DEPTH);
            }
            skipSpace();
            if (at >= text.length()) {
                throw new NotJson("the text ends before a value");
            }
            char c = text.charAt(at);
            return switch (c) {
                case '{' -> object(depth);
                case '[' -> array(depth);
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> {
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        yield number();
                    }
                    throw new NotJson("not JSON at " + at);
                }
            };
        }

        private Map<String, Object> object(int depth) {
            at++;
            Map<String, Object> object = new LinkedHashMap<>();
            skipSpace();
            if (peek() == '}') {
                at++;
                return object;
            }
            while (true) {
                skipSpace();
                if (peek() != '"') {
                    throw new NotJson("an object key is not a string at " + at);
                }
                String key = string();
                skipSpace();
                expect(':');
                Object member = value(depth + 1);
                if (object.containsKey(key)) {
                    throw new NotJson("a duplicate key at " + at);
                }
                object.put(key, member);
                skipSpace();
                char c = next();
                if (c == '}') {
                    return object;
                }
                if (c != ',') {
                    throw new NotJson("an object is not closed at " + (at - 1));
                }
            }
        }

        private List<Object> array(int depth) {
            at++;
            List<Object> array = new ArrayList<>();
            skipSpace();
            if (peek() == ']') {
                at++;
                return array;
            }
            while (true) {
                array.add(value(depth + 1));
                skipSpace();
                char c = next();
                if (c == ']') {
                    return array;
                }
                if (c != ',') {
                    throw new NotJson("an array is not closed at " + (at - 1));
                }
            }
        }

        private String string() {
            at++;
            StringBuilder out = new StringBuilder();
            while (true) {
                if (at >= text.length()) {
                    throw new NotJson("a string is not closed");
                }
                char c = text.charAt(at++);
                if (c == '"') {
                    return out.toString();
                }
                if (c < 0x20) {
                    throw new NotJson("a control character in a string at " + (at - 1));
                }
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char e = next();
                switch (e) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        if (at + 4 > text.length()) {
                            throw new NotJson("a \\u escape is cut short");
                        }
                        int code = 0;
                        for (int i = 0; i < 4; i++) {
                            int d = Character.digit(text.charAt(at++), 16);
                            if (d < 0) {
                                throw new NotJson("a \\u escape is not hex at " + (at - 1));
                            }
                            code = code * 16 + d;
                        }
                        out.append((char) code);
                    }
                    default -> throw new NotJson("an unknown escape at " + (at - 1));
                }
            }
        }

        private Double number() {
            int start = at;
            if (peek() == '-') {
                at++;
            }
            if (peek() == '0') {
                at++;
            } else if (isDigit(peek())) {
                while (isDigit(peek())) {
                    at++;
                }
            } else {
                throw new NotJson("a number has no digits at " + start);
            }
            if (peek() == '.') {
                at++;
                if (!isDigit(peek())) {
                    throw new NotJson("a fraction has no digits at " + at);
                }
                while (isDigit(peek())) {
                    at++;
                }
            }
            if (peek() == 'e' || peek() == 'E') {
                at++;
                if (peek() == '+' || peek() == '-') {
                    at++;
                }
                if (!isDigit(peek())) {
                    throw new NotJson("an exponent has no digits at " + at);
                }
                while (isDigit(peek())) {
                    at++;
                }
            }
            double v = Double.parseDouble(text.substring(start, at));
            if (Double.isInfinite(v)) {
                throw new NotJson("a number past the doubles at " + start);
            }
            return v;
        }

        private Object literal(String word, Object value) {
            if (!text.startsWith(word, at)) {
                throw new NotJson("not JSON at " + at);
            }
            at += word.length();
            return value;
        }

        void skipSpace() {
            while (at < text.length()) {
                char c = text.charAt(at);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
                    return;
                }
                at++;
            }
        }

        private char peek() {
            return at < text.length() ? text.charAt(at) : '\0';
        }

        private char next() {
            if (at >= text.length()) {
                throw new NotJson("the text ends early");
            }
            return text.charAt(at++);
        }

        private void expect(char c) {
            if (next() != c) {
                throw new NotJson("expected '" + c + "' at " + (at - 1));
            }
        }

        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }
    }
}
