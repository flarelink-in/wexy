package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.schemas.JsonSchemas;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.MemoryCacheImageInputStream;
import java.awt.image.Raster;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * One review's request, as {@code POST /v1/agent/review} takes it (EA6.4; the frontend's visual-review design §9, §9.1,
 * EA-VR8): the frames of the world on the stage, R and S, the candidate's modules, the host's findings the creator kept,
 * and the creator's consent to the provider and its policy.
 *
 * <p>Everything is checked here, before any record or charge, and nothing is kept past the call: the fields, exactly; 1
 * or 2 frames, each a JPEG given as standard padded base64 (never a URL, never a data URL), at most
 * {@value #MAX_JPEG_BYTES} bytes and {@value #MAX_PAIR_BYTES} together, whole (its structure walked from its start to its
 * end: one 8-bit frame of {@value #WIDTH} × {@value #HEIGHT} in 1 or 3 components, at most {@value #MAX_SCANS} scans,
 * nothing after its end; then its image decoded, a decoder's warning as much a refusal as its error), and whose SHA-256
 * is the frame's own; R within a turn's caps; S against {@code agent-action.v3}; at most {@value #MAX_MODULES} module
 * ids, each once; at most {@value #MAX_FINDINGS} host findings within the backend's finding bounds (a message in code
 * points, as both sides count it); and a consent naming exactly this server's provider, model and policy version. Whose
 * turn it is is the handler's to say, asked here before anything costly; whether its prompt has a review left, the
 * handler's to check.
 */
public record ReviewRequest(String reviewId, String turnId, JsonNode subject, AgentRequest request, JsonNode design, List<String> modules,
                            List<Frame> frames, List<HostFinding> hostFindings) {

    /** The fields of a request: no other is taken (the design §9). */
    static final List<String> FIELDS = List.of("reviewId", "turnId", "subject", "request", "design", "modules", "frames", "hostFindings", "consent");
    static final List<String> FRAME_KEYS = List.of("id", "view", "tick", "seconds", "width", "height", "sha256", "jpeg");
    static final List<String> FINDING_KEYS = List.of("code", "message");
    static final List<String> CONSENT_KEYS = List.of("provider", "model", "policyVersion");
    /** The whole request, in bytes, base64 and JSON included: the gateway's cap for this route, and the handler's read. */
    public static final int MAX_REQUEST_BYTES = 1_048_576;
    /** Q108's frames: aspect-fit into 768 × 432 by the browser, so every frame is exactly that size. */
    public static final int WIDTH = 768;
    public static final int HEIGHT = 432;
    public static final int MAX_FRAMES = 2;
    public static final int MAX_JPEG_BYTES = 300_000;
    public static final int MAX_PAIR_BYTES = 600_000;
    /**
     * A frame's scans: a browser's canvas writes one (baseline), a progressive encoder about ten; a decoder's work grows
     * with each, so more are refused before it starts.
     */
    static final int MAX_SCANS = 16;
    /** A JPEG of MAX_JPEG_BYTES is this many base64 characters: a longer string is refused before it is decoded. */
    static final int MAX_BASE64_CHARS = (MAX_JPEG_BYTES + 2) / 3 * 4;
    /** The candidate's modules: Q_C's 12 (AgentTurn.MAX_MODULES). */
    static final int MAX_MODULES = 12;
    /** The revision's bound on findings (AgentBase), which the creator's choices also meet. */
    static final int MAX_FINDINGS = 32;
    static final int FINDING_CHARS = 400;
    static final int CODE_CHARS = 40;
    static final Set<String> VIEWS = Set.of("framed", "side");
    /** A frame's id, as the browser names it: its review's and its draw, `review-3.v1`. */
    static final Pattern FRAME_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    /** One frame, decoded and checked: its identity as the browser sent it, and the JPEG it hashed. */
    public record Frame(String id, String view, long tick, double seconds, String sha256, byte[] jpeg) {
    }

    /** One of the host's findings the creator kept: its code and its sentence. */
    public record HostFinding(String code, String message) {
    }

    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /**
     * The request's text, checked whole against the terms it was sent under: a 400 or 413 that says what is wrong, never
     * anything recorded or charged. {@code model} is the review role's, {@code provider} and {@code policyVersion} the
     * configured disclosure's. {@code owner} is asked whether the turn is the caller's once its id is read, before any
     * costly check (S against its schema, the frames decoded): it throws when it is not (the independent review of EA6.4:
     * any caller could make this service decode two frames for a turn not theirs).
     */
    static ReviewRequest validated(String text, LoopProperties.Caps caps, JsonSchemas schemas, String provider, String model, String policyVersion,
                                   Consumer<String> owner) {
        if (text.length() > MAX_REQUEST_BYTES || ModuleRequest.utf8(text) > MAX_REQUEST_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "A review request is at most " + MAX_REQUEST_BYTES + " bytes.");
        }
        JsonNode body;
        try {
            body = JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw ModuleRequest.bad("The request is not JSON.");
        }
        if (body == null || !body.isObject()) {
            throw ModuleRequest.bad("The request must be a JSON object.");
        }
        ModuleRequest.exactly(body, FIELDS, "A review request");

        // The consent first: a browser that consented to another provider, model or policy is asked again, before anything.
        JsonNode consent = body.path("consent");
        ModuleRequest.exactly(consent, CONSENT_KEYS, "consent");
        if (!provider.equals(consent.path("provider").asText(null)) || !model.equals(consent.path("model").asText(null))
                || !policyVersion.equals(consent.path("policyVersion").asText(null))) {
            throw ModuleRequest.bad("consent names " + ModuleRequest.shown(consent.path("provider")) + ", " + ModuleRequest.shown(consent.path("model"))
                    + " and policy " + ModuleRequest.shown(consent.path("policyVersion")) + "; this server sends frames to " + provider + "'s "
                    + model + " under policy " + policyVersion + ": ask the creator again.");
        }

        String reviewId = body.path("reviewId").isTextual() ? body.path("reviewId").asText() : null;
        if (reviewId == null || !ModuleRequest.ID.matcher(reviewId).matches()) {
            throw ModuleRequest.bad("reviewId is 1 to 64 letters, digits, - or _.");
        }
        String turnId = body.path("turnId").isTextual() ? body.path("turnId").asText() : null;
        if (turnId == null || !ModuleRequest.ULID.matcher(turnId).matches()) {
            throw ModuleRequest.bad("turnId is the turn of the candidate on the stage, 26 characters.");
        }
        owner.accept(turnId);
        JsonNode subject = body.path("subject");
        checkedSubject(subject);

        if (!body.path("request").isObject()) {
            throw ModuleRequest.bad("request is the turn's own request, {prompt, style, seconds}.");
        }
        AgentRequest request = AgentHandler.validated(body.path("request"), caps);

        // S as the turn handed it off, checked by the action schema itself, as a module call's is.
        JsonNode design = body.path("design");
        if (!design.isObject()) {
            throw ModuleRequest.bad("design is the turn's design, an object.");
        }
        ObjectNode action = JSON.createObjectNode().put("kind", "propose_design").putNull("context");
        action.set("design", design);
        action.putNull("program").putNull("modules").putNull("revision").putNull("question").putNull("finish");
        List<String> designProblems = schemas.validate(JsonSchemas.AGENT_ACTION, action);
        if (!designProblems.isEmpty()) {
            throw ModuleRequest.bad("design does not fit " + JsonSchemas.AGENT_ACTION + ": " + ModuleRequest.clip(designProblems.get(0)));
        }

        JsonNode list = body.path("modules");
        if (!list.isArray() || list.size() > MAX_MODULES) {
            throw ModuleRequest.bad("modules is the candidate's module ids, at most " + MAX_MODULES + ".");
        }
        List<String> modules = new ArrayList<>();
        for (JsonNode m : list) {
            if (!m.isTextual() || !ModuleRequest.MODULE.matcher(m.asText()).matches()) {
                throw ModuleRequest.bad("A module id is 1 to 40 letters, digits, - or _.");
            }
            if (modules.contains(m.asText())) {
                throw ModuleRequest.bad("modules names " + m.asText() + " twice.");
            }
            modules.add(m.asText());
        }

        return new ReviewRequest(reviewId, turnId, subject, request, design, List.copyOf(modules), checkedFrames(body.path("frames")),
                checkedFindings(body.path("hostFindings")));
    }

    /**
     * The candidate on the stage (§5's subject): its attempt and revision, its program's and X's hashes and id(C), with no
     * module; a review is about the whole candidate.
     */
    private static void checkedSubject(JsonNode s) {
        ModuleRequest.exactly(s, ModuleRequest.SUBJECT_KEYS, "subject");
        if (!s.path("attempt").isTextual() || !ModuleRequest.ID.matcher(s.path("attempt").asText()).matches()) {
            throw ModuleRequest.bad("subject.attempt is 1 to 64 letters, digits, - or _.");
        }
        if (!s.path("revision").isInt() || s.path("revision").asInt() < 0 || s.path("revision").asInt() > 10_000) {
            throw ModuleRequest.bad("subject.revision is a whole number, 0 to 10000.");
        }
        for (String key : List.of("programHash", "graph", "candidate")) {
            if (!s.path(key).isTextual() || !ModuleRequest.HASH.matcher(s.path(key).asText()).matches()) {
                throw ModuleRequest.bad("subject." + key + " is 64 lower-case hex digits: a review is of a sealed candidate.");
            }
        }
        for (String key : List.of("module", "interfaceHash", "codeHash")) {
            if (!s.path(key).isNull()) {
                throw ModuleRequest.bad("subject." + key + " is null: a review is of the whole candidate, not one module.");
            }
        }
    }

    private static List<Frame> checkedFrames(JsonNode list) {
        if (!list.isArray() || list.isEmpty() || list.size() > MAX_FRAMES) {
            throw ModuleRequest.bad("frames is 1 or " + MAX_FRAMES + " frames of the world on the stage.");
        }
        List<Frame> frames = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        Set<String> views = new HashSet<>();
        long total = 0;
        for (int i = 0; i < list.size(); i++) {
            JsonNode f = list.get(i);
            String at = "frames[" + i + "]";
            ModuleRequest.exactly(f, FRAME_KEYS, at);
            String id = f.path("id").isTextual() ? f.path("id").asText() : null;
            if (id == null || !FRAME_ID.matcher(id).matches() || !ids.add(id)) {
                throw ModuleRequest.bad(at + ".id is 1 to 64 letters, digits, ., - or _, and each frame's is its own.");
            }
            String view = f.path("view").asText(null);
            if (!f.path("view").isTextual() || !VIEWS.contains(view) || !views.add(view)) {
                throw ModuleRequest.bad(at + ".view is framed or side, each at most once.");
            }
            if (!f.path("tick").isIntegralNumber() || !f.path("tick").canConvertToLong() || f.path("tick").asLong() < 0) {
                throw ModuleRequest.bad(at + ".tick is the world's fixed-step count, a whole number of 0 or more.");
            }
            double seconds = f.path("seconds").asDouble(-1);
            if (!f.path("seconds").isNumber() || !Double.isFinite(seconds) || seconds < 0) {
                throw ModuleRequest.bad(at + ".seconds is the world's time, 0 or more.");
            }
            if (!f.path("width").isInt() || f.path("width").asInt() != WIDTH || !f.path("height").isInt() || f.path("height").asInt() != HEIGHT) {
                throw ModuleRequest.bad(at + " is " + WIDTH + " × " + HEIGHT + " (Q108): width and height say so.");
            }
            String sha256 = f.path("sha256").asText(null);
            if (!f.path("sha256").isTextual() || !ModuleRequest.HASH.matcher(sha256).matches()) {
                throw ModuleRequest.bad(at + ".sha256 is 64 lower-case hex digits.");
            }
            byte[] jpeg = decoded(f.path("jpeg"), at);
            Jpeg whole;
            try {
                whole = jpeg(jpeg);
            } catch (NotAWholeJpeg e) {
                throw ModuleRequest.bad(at + ".jpeg is not a whole JPEG: " + e.getMessage() + ".");
            }
            // Its size and its scans before its image is decoded: they bound the decoder's memory and its work.
            if (whole.width() != WIDTH || whole.height() != HEIGHT) {
                throw ModuleRequest.bad(at + ".jpeg is " + whole.width() + " × " + whole.height() + "; a review frame is " + WIDTH + " × " + HEIGHT + ".");
            }
            if (whole.scans() > MAX_SCANS) {
                throw ModuleRequest.bad(at + ".jpeg has " + whole.scans() + " scans; at most " + MAX_SCANS + ".");
            }
            if (!sha256.equals(sha256(jpeg))) {
                throw ModuleRequest.bad(at + ".sha256 is not the SHA-256 of its JPEG: the frame is not the one the browser hashed.");
            }
            total += jpeg.length;
            if (total > MAX_PAIR_BYTES) {
                throw new ForgeException(ErrorCode.TOO_LARGE, "EA_REVIEW_SIZE frames: " + total + " exceeds " + MAX_PAIR_BYTES + " bytes together.");
            }
            // Last, as the costliest: the image decodes whole (the outside review of EA6.4: a start, a frame header and an
            // end passed while the scan between them was cut, corrupt or missing).
            String undecodable = undecodable(whole);
            if (undecodable != null) {
                throw ModuleRequest.bad(at + ".jpeg does not decode whole: " + undecodable + ".");
            }
            frames.add(new Frame(id, view, f.path("tick").asLong(), seconds, sha256, jpeg));
        }
        return List.copyOf(frames);
    }

    /** A frame's JPEG from its base64: standard, padded, and no longer than a JPEG of MAX_JPEG_BYTES. Never a URL. */
    private static byte[] decoded(JsonNode v, String at) {
        if (!v.isTextual() || v.asText().isEmpty()) {
            throw ModuleRequest.bad(at + ".jpeg is the JPEG's bytes in base64.");
        }
        String text = v.asText();
        if (text.length() > MAX_BASE64_CHARS) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "EA_REVIEW_SIZE " + at + ".jpeg: more than " + MAX_JPEG_BYTES + " bytes.");
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            // Never echoed: a frame's text is the creator's world, and an error goes to logs.
            throw ModuleRequest.bad(at + ".jpeg is the JPEG's bytes in standard padded base64, never a URL or a data URL.");
        }
        if (bytes.length > MAX_JPEG_BYTES) {
            throw new ForgeException(ErrorCode.TOO_LARGE, "EA_REVIEW_SIZE " + at + ".jpeg: " + bytes.length + " exceeds " + MAX_JPEG_BYTES + " bytes.");
        }
        return bytes;
    }

    private static List<HostFinding> checkedFindings(JsonNode list) {
        if (!list.isArray() || list.size() > MAX_FINDINGS) {
            throw ModuleRequest.bad("hostFindings is the host's findings the creator kept, at most " + MAX_FINDINGS + ".");
        }
        List<HostFinding> findings = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            JsonNode f = list.get(i);
            ModuleRequest.exactly(f, FINDING_KEYS, "hostFindings[" + i + "]");
            String code = f.path("code").asText(null);
            String message = f.path("message").asText(null);
            if (!f.path("code").isTextual() || code.isEmpty() || code.length() > CODE_CHARS || !ModuleRequest.ID.matcher(code).matches()) {
                throw ModuleRequest.bad("hostFindings[" + i + "].code is 1 to " + CODE_CHARS + " letters, digits, - or _.");
            }
            if (!f.path("message").isTextual() || ModuleRequest.blank(message) || ModuleRequest.codePoints(message) > FINDING_CHARS) {
                throw ModuleRequest.bad("hostFindings[" + i + "].message says what was measured, 1 to " + FINDING_CHARS + " characters.");
            }
            findings.add(new HostFinding(code, message));
        }
        return List.copyOf(findings);
    }

    /**
     * A JPEG as its structure says, walked whole: the size of its one frame, its components, its scans, and its image's
     * own segments (its start, tables, frame header, scans and end, its metadata left out) for the decoder.
     */
    record Jpeg(int width, int height, int components, int scans, byte[] image) {
    }

    /** Why bytes are not a whole JPEG; said in a refusal, never with the bytes themselves. */
    static final class NotAWholeJpeg extends RuntimeException {
        NotAWholeJpeg(String why) {
            super(why, null, false, false);
        }
    }

    /**
     * A JPEG's structure, walked whole from its start of image to its end of image, which must be its last two bytes (the
     * outside review of EA6.4: the first frame header alone said nothing of the rest). Before the first scan: segments
     * that fit, each a table (DQT, DHT), a restart interval, a comment, application data (APP0 to APP15; walked, never
     * read) or the one frame header, which is baseline, extended or progressive (SOF0 to SOF2: Huffman-coded, as every
     * browser's encoder writes), 8-bit, of 1 or 3 components each described once with sampling 1 to 4 and a table 0 to 3.
     * Each scan's header names the frame's own components, each once, and its data runs to the next marker (FF 00 is a
     * byte of data, FF D0 to D7 a restart, FF FF a fill); between scans, the same segments but a frame header. Anything
     * else, a second frame header, a scan with no data or no scan at all is not a whole JPEG. Whether the scans decode is
     * {@link #undecodable}'s question; how many there may be, and the size, the caller's.
     *
     * @throws NotAWholeJpeg with why, never with any of the bytes
     */
    static Jpeg jpeg(byte[] b) {
        int n = b.length;
        if (n < 4 || (b[0] & 0xFF) != 0xFF || (b[1] & 0xFF) != 0xD8 || (b[n - 2] & 0xFF) != 0xFF || (b[n - 1] & 0xFF) != 0xD9) {
            throw new NotAWholeJpeg("no start of image, or no end of image as its last two bytes");
        }
        ByteArrayOutputStream image = new ByteArrayOutputStream(n);
        image.write(b, 0, 2);
        int width = 0;
        int height = 0;
        int scans = 0;
        int[] components = null;
        // Here i <= n - 2 always: every segment and every scan ends at or before the end of image, FF D9 at n - 2.
        int i = 2;
        while (true) {
            if ((b[i] & 0xFF) != 0xFF) {
                throw new NotAWholeJpeg("a byte at " + i + " where a marker belongs");
            }
            while ((b[i + 1] & 0xFF) == 0xFF) {
                i++; // fill before a marker; b[n - 1] is D9, so this stops by n - 2
            }
            int marker = b[i + 1] & 0xFF;
            if (marker == 0xD9) {
                if (i != n - 2) {
                    throw new NotAWholeJpeg("bytes after its end of image");
                }
                if (scans == 0) {
                    throw new NotAWholeJpeg("no scan");
                }
                image.write(b, i, 2);
                return new Jpeg(width, height, components.length, scans, image.toByteArray());
            }
            boolean metadata = marker == 0xFE || (marker >= 0xE0 && marker <= 0xEF);
            boolean table = marker == 0xC4 || marker == 0xDB || marker == 0xDD;
            boolean frame = marker == 0xC0 || marker == 0xC1 || marker == 0xC2;
            if (!metadata && !table && !frame && marker != 0xDA) {
                throw new NotAWholeJpeg("marker " + String.format("FF%02X", marker) + ", which no browser's JPEG holds");
            }
            if (i + 3 >= n - 2) {
                throw new NotAWholeJpeg("a segment past its end");
            }
            int length = ((b[i + 2] & 0xFF) << 8) | (b[i + 3] & 0xFF);
            int end = i + 2 + length;
            if (length < 2 || end > n - 2) {
                throw new NotAWholeJpeg("a segment past its end");
            }
            int at = i + 4;
            if (frame) {
                if (components != null) {
                    throw new NotAWholeJpeg("a second frame header");
                }
                if (length < 8) {
                    throw new NotAWholeJpeg("a frame header cut short");
                }
                int precision = b[at] & 0xFF;
                height = ((b[at + 1] & 0xFF) << 8) | (b[at + 2] & 0xFF);
                width = ((b[at + 3] & 0xFF) << 8) | (b[at + 4] & 0xFF);
                int count = b[at + 5] & 0xFF;
                if (precision != 8) {
                    throw new NotAWholeJpeg(precision + "-bit samples; a frame's are 8-bit");
                }
                if (count != 1 && count != 3) {
                    throw new NotAWholeJpeg(count + " components; a frame has 1 or 3");
                }
                if (length != 8 + 3 * count) {
                    throw new NotAWholeJpeg("a frame header of " + length + " bytes for " + count + " components");
                }
                components = new int[count];
                for (int c = 0; c < count; c++) {
                    int id = b[at + 6 + 3 * c] & 0xFF;
                    int sampling = b[at + 7 + 3 * c] & 0xFF;
                    int quantTable = b[at + 8 + 3 * c] & 0xFF;
                    if ((sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 0x0F) < 1 || (sampling & 0x0F) > 4 || quantTable > 3) {
                        throw new NotAWholeJpeg("component " + id + "'s sampling or table is out of range");
                    }
                    if (indexOf(components, c, id) >= 0) {
                        throw new NotAWholeJpeg("component " + id + " twice in its frame header");
                    }
                    components[c] = id;
                }
            } else if (marker == 0xDA) {
                if (components == null) {
                    throw new NotAWholeJpeg("a scan before its frame header");
                }
                int count = length < 8 ? 0 : b[at] & 0xFF;
                if (count < 1 || count > components.length || length != 6 + 2 * count) {
                    throw new NotAWholeJpeg("a scan header of " + length + " bytes");
                }
                int[] named = new int[count];
                for (int c = 0; c < count; c++) {
                    int id = b[at + 1 + 2 * c] & 0xFF;
                    if (indexOf(components, components.length, id) < 0 || indexOf(named, c, id) >= 0) {
                        throw new NotAWholeJpeg("a scan of component " + id + ", which is not its frame's, or twice");
                    }
                    named[c] = id;
                }
                scans++;
                int j = end;
                while (true) {
                    if ((b[j] & 0xFF) != 0xFF) {
                        j++;
                        continue;
                    }
                    int next = b[j + 1] & 0xFF;
                    if (next == 0x00 || (next >= 0xD0 && next <= 0xD7)) {
                        j += 2;
                    } else if (next == 0xFF) {
                        j++;
                    } else {
                        break;
                    }
                }
                if (j == end) {
                    throw new NotAWholeJpeg("a scan with no data");
                }
                end = j;
            }
            if (!metadata) {
                image.write(b, i, end - i);
            }
            i = end;
        }
    }

    private static int indexOf(int[] ids, int count, int id) {
        for (int k = 0; k < count; k++) {
            if (ids[k] == id) {
                return k;
            }
        }
        return -1;
    }

    /**
     * Why a JPEG whose structure is whole does not decode whole, or null when it does (the outside review of EA6.4): its
     * image's own segments, decoded once to the raster's last line by the runtime's JPEG reader, with no colour
     * conversion. Its error, or any warning it gives (a cut or corrupt scan, data it skipped, a table never defined), is
     * the answer: a decoder that guessed past it would hand the model an image no one sent. Its metadata is not decoded:
     * a colour profile the runtime dislikes is not a broken frame. The work and the memory are bounded by the structure's
     * size and scans, checked first; the stream is held in memory, never cached on a disk, and nothing of it is kept.
     */
    static String undecodable(Jpeg jpeg) {
        Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName("jpeg");
        if (!readers.hasNext()) {
            throw new IllegalStateException("This runtime has no JPEG reader to check a review's frames with.");
        }
        ImageReader reader = readers.next();
        List<String> warnings = new ArrayList<>(1);
        try (ImageInputStream in = new MemoryCacheImageInputStream(new ByteArrayInputStream(jpeg.image()))) {
            reader.setInput(in, true, true);
            reader.addIIOReadWarningListener((source, warning) -> warnings.add(warning));
            Raster raster = reader.readRaster(0, null);
            if (!warnings.isEmpty()) {
                return said(warnings.get(0));
            }
            if (raster.getWidth() != jpeg.width() || raster.getHeight() != jpeg.height()) {
                return "it decodes as " + raster.getWidth() + " × " + raster.getHeight();
            }
            return null;
        } catch (IOException | RuntimeException e) {
            return said(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            reader.dispose();
        }
    }

    /** A decoder's words, short: they name what went wrong, never the bytes. */
    private static String said(String words) {
        String s = words.strip();
        return s.length() > 120 ? s.substring(0, 120) : s;
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }
}
