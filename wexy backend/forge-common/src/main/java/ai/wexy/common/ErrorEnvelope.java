package ai.wexy.common;

import java.util.Objects;

/**
 * The body of every error either service returns: {@code {"code":"…","message":"…"}}.
 *
 * Serialised by hand so that the gateway's shield, which answers before any codec is involved, and
 * the service write the same bytes, and so that this module needs no dependency. The message is
 * ours: callers never pass upstream bodies, stack traces or SQL into it (coding principles §9).
 */
public record ErrorEnvelope(String code, String message) {

    public ErrorEnvelope {
        Objects.requireNonNull(code, "code");
        Objects.requireNonNull(message, "message");
    }

    public static ErrorEnvelope of(ErrorCode code, String message) {
        return new ErrorEnvelope(code.code(), message);
    }

    public String toJson() {
        return "{\"code\":\"" + escape(code) + "\",\"message\":\"" + escape(message) + "\"}";
    }

    /** JSON string escaping (RFC 8259 §7): quote, backslash and every control character. */
    static String escape(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }
}
