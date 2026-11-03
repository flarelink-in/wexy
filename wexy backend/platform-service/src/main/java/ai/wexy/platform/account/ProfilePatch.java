package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.Ulid;
import ai.wexy.platform.error.PlatformException;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.Iterator;
import java.util.Set;

/**
 * The body of {@code PATCH /v1/me/profile} (W2; the creations platform design §10), held to its closed shape:
 * {@code accountId} and {@code expectedVersion} (both required), and at least one of {@code handle}, {@code
 * displayName} and {@code bio}. Any other field is refused, so a client cannot name a status, a role or a public flag
 * (PL-T3); making a profile public comes with the showcase and its content safety (W4, Q99).
 *
 * {@code accountId} picks nothing: it is the account the change was prepared for, a precondition beside the version
 * (the W2 review). The caller's own account is still the one written, and a change prepared for another one is refused,
 * so what a creator typed for one account never lands on the account a later token belongs to.
 *
 * Text is held to what a page can show as text: trimmed, at most 50 (a display name) or 280 (a bio) code points, the
 * database's own column sizes; no control characters (a bio may break lines), no unpaired surrogates, and none of the
 * invisible direction overrides that make text read other than it is stored. An empty text clears the field, as null
 * does; an absent one leaves it.
 */
public record ProfilePatch(String accountId, long expectedVersion, String handle, Text displayName, Text bio) {

    static final int DISPLAY_NAME_CODE_POINTS = 50;
    static final int BIO_CODE_POINTS = 280;

    private static final Set<String> FIELDS = Set.of("accountId", "expectedVersion", "handle", "displayName", "bio");

    /** A text field's change: none, cleared, or set to a value. */
    public record Text(boolean present, String value) {
        static final Text ABSENT = new Text(false, null);

        /** The field's new value, or {@code current} when the patch leaves it. */
        public String or(String current) {
            return present ? value : current;
        }
    }

    /** The patch in `body`, or a 400 saying what is wrong with it. */
    public static ProfilePatch parse(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw bad("The profile change is a JSON object.");
        }
        for (Iterator<String> names = body.fieldNames(); names.hasNext(); ) {
            String name = names.next();
            if (!FIELDS.contains(name)) {
                throw bad("A profile change has no field \"" + clip(name) + "\".");
            }
        }
        JsonNode account = body.get("accountId");
        if (account == null || !account.isTextual() || !Ulid.looksLikeOne(account.textValue())) {
            throw bad("accountId is the account the change was prepared for: the accountId GET /v1/me gave.");
        }
        JsonNode version = body.get("expectedVersion");
        if (version == null || !version.isIntegralNumber() || !version.canConvertToLong() || version.asLong() < 0) {
            throw bad("expectedVersion is the profile's rowVersion, a whole number.");
        }
        if (!body.has("handle") && !body.has("displayName") && !body.has("bio")) {
            throw bad("A profile change names a handle, a display name or a bio.");
        }
        String handle = null;
        if (body.has("handle")) {
            if (!body.get("handle").isTextual()) {
                throw bad("A handle is text, and once claimed it stays.");
            }
            handle = body.get("handle").textValue();
        }
        return new ProfilePatch(account.textValue(), version.asLong(), handle,
                text(body, "displayName", DISPLAY_NAME_CODE_POINTS, false),
                text(body, "bio", BIO_CODE_POINTS, true));
    }

    private static Text text(JsonNode body, String field, int maxCodePoints, boolean lines) {
        if (!body.has(field)) {
            return Text.ABSENT;
        }
        JsonNode node = body.get(field);
        if (node.isNull()) {
            return new Text(true, null);
        }
        if (!node.isTextual()) {
            throw bad(field + " is text or null.");
        }
        String value = node.textValue().strip();
        if (value.isEmpty()) {
            return new Text(true, null);
        }
        if (value.codePointCount(0, value.length()) > maxCodePoints) {
            throw bad(field + " is at most " + maxCodePoints + " characters.");
        }
        for (int i = 0; i < value.length(); ) {
            int c = value.codePointAt(i);
            if (!allowed(c, lines)) {
                throw bad(field + " holds a character a page cannot show as text.");
            }
            i += Character.charCount(c);
        }
        return new Text(true, value);
    }

    private static boolean allowed(int c, boolean lines) {
        if (c == '\n') {
            return lines;
        }
        // A control character, or half of a surrogate pair standing alone (a whole pair arrives as one code point).
        if (Character.isISOControl(c) || (c >= Character.MIN_SURROGATE && c <= Character.MAX_SURROGATE)) {
            return false;
        }
        // Line and paragraph separators, and the bidirectional embeddings, overrides and isolates.
        if (c == 0x2028 || c == 0x2029 || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)) {
            return false;
        }
        return Character.isDefined(c);
    }

    private static String clip(String name) {
        return name.length() <= 40 ? name : name.substring(0, 40) + "…";
    }

    private static PlatformException bad(String message) {
        return new PlatformException(ErrorCode.BAD_REQUEST, message);
    }
}
