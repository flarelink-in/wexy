package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A creator's {@code @handle} (W2; the creations platform design §6): ASCII letters, digits and underscores, 3 to 30 of
 * them, stored lowercase, so {@code Nova} and {@code nova} are one handle and the database's uniqueness covers both
 * (PL-T3). Anything else is refused rather than mapped: a fullwidth or dotless letter is not quietly turned into
 * ASCII, which is how look-alike handles are made. Names the product or its staff would use are reserved, as is any
 * handle starting with {@code wexy}.
 */
public final class Handle {

    private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_]{3,30}");

    static final String RESOURCE = "/reserved-handles.txt";

    private final Set<String> reserved;
    private final List<String> reservedPrefixes;

    Handle(Set<String> reserved, List<String> reservedPrefixes) {
        this.reserved = Set.copyOf(reserved);
        this.reservedPrefixes = List.copyOf(reservedPrefixes);
    }

    /** The reserved names in {@value #RESOURCE}: one a line, {@code #} comments, a trailing {@code *} for a prefix. */
    public static Handle reservedFromResource() {
        try (InputStream in = Handle.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is missing from the classpath.");
            }
            Set<String> names = new HashSet<>();
            List<String> prefixes = new ArrayList<>();
            for (String line : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                String entry = line.strip().toLowerCase(Locale.ROOT);
                if (entry.isEmpty() || entry.startsWith("#")) {
                    continue;
                }
                if (entry.endsWith("*")) {
                    prefixes.add(entry.substring(0, entry.length() - 1));
                } else {
                    names.add(entry);
                }
            }
            return new Handle(names, prefixes);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The handle as stored, or a 400 saying what is wrong with `raw`. */
    public String normalize(String raw) {
        if (raw == null || !SHAPE.matcher(raw).matches()) {
            throw new PlatformException(ErrorCode.BAD_REQUEST,
                    "A handle is 3 to 30 letters (a to z), digits or underscores.");
        }
        String handle = raw.toLowerCase(Locale.ROOT);
        if (reserved.contains(handle) || reservedPrefixes.stream().anyMatch(handle::startsWith)) {
            throw new PlatformException(ErrorCode.BAD_REQUEST, "That handle is reserved. Try another.");
        }
        return handle;
    }
}
