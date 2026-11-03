package ai.wexy.forge.agent;

import ai.wexy.common.ErrorCode;
import ai.wexy.forge.error.ForgeException;
import ai.wexy.forge.loop.LoopProperties;
import ai.wexy.forge.schemas.JsonSchemas;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * EA-VR8's backend half (the frontend's visual-review design §9, §9.1, §10): a review's request is checked whole before
 * any record or charge. Each bound at its limit passes and one past it is refused, base64 counted as it travels; a frame
 * that is not a whole 768 × 432 JPEG, whose hash is not its own, or that is a URL is refused; so are a consent to another
 * provider, model or policy, and a subject that is not a sealed candidate's. No message echoes a frame's bytes.
 */
class ReviewRequestTest {

    static final ObjectMapper JSON = new ObjectMapper();
    static final JsonNode PROGRAM = ProgramCheckTest.read("mock/agent/program.json");
    static final LoopProperties.Caps CAPS = new LoopProperties(null, Duration.ofSeconds(15), null, false).caps();
    static final JsonSchemas SCHEMAS = new JsonSchemas();
    static final String HASH = "a".repeat(64);
    static final String TURN = "01JBZ6Q3G8XW0Y4N6R2T5V7K9M";

    /** A real 768 × 432 JPEG, the probe's floating cube. */
    static final byte[] JPEG = VisionProbe.frame(true);

    /** `jpeg` padded to exactly `size` bytes with comment segments after its start, so its frame header and end stay whole. */
    static byte[] padded(byte[] jpeg, int size) {
        int room = size - jpeg.length;
        assertThat(room).as("the frame is smaller than the size asked").isGreaterThanOrEqualTo(0);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(jpeg, 0, 2);
        while (room > 0) {
            // A COM segment: FF FE, a length that counts itself (2 to 65,535), then its bytes.
            int segment = Math.min(room, 65_537);
            if (room - segment == 1 || room - segment == 2 || room - segment == 3) {
                segment -= 4;
            }
            if (segment < 4) {
                segment = room;
            }
            int length = segment - 2;
            out.write(0xFF);
            out.write(0xFE);
            out.write(length >> 8);
            out.write(length & 0xFF);
            byte[] fill = new byte[length - 2];
            Arrays.fill(fill, (byte) 'w');
            out.write(fill, 0, fill.length);
            room -= segment;
        }
        out.write(jpeg, 2, jpeg.length - 2);
        byte[] result = out.toByteArray();
        assertThat(result).hasSize(size);
        return result;
    }

    static ObjectNode frame(String id, String view, byte[] jpeg) {
        ObjectNode f = JSON.createObjectNode();
        f.put("id", id).put("view", view).put("tick", 42).put("seconds", 0.7).put("width", 768).put("height", 432)
                .put("sha256", ReviewRequest.sha256(jpeg)).put("jpeg", Base64.getEncoder().encodeToString(jpeg));
        return f;
    }

    /** A valid request: two frames, R, S, two modules, one host finding, and the consent this server's terms ask for. */
    static ObjectNode request() {
        ObjectNode b = JSON.createObjectNode();
        b.put("reviewId", "review-1").put("turnId", TURN);
        b.putObject("subject").put("attempt", "attempt-1").put("revision", 1).put("programHash", HASH).put("graph", HASH).put("candidate", HASH)
                .putNull("module").putNull("interfaceHash").putNull("codeHash");
        b.putObject("request").put("prompt", "a toon castle on a green hill").put("style", "cinematic").put("seconds", 12);
        b.set("design", PROGRAM.path("design").deepCopy());
        b.putArray("modules").add("castlePlace").add("flagFlutter");
        ArrayNode frames = b.putArray("frames");
        frames.add(frame("review-1.v1", "framed", JPEG));
        frames.add(frame("review-1.v2", "side", VisionProbe.frame(false)));
        b.putArray("hostFindings").addObject().put("code", "EA_SCALE").put("message", "hill#batch's largest side is 26 times the rest's.");
        b.putObject("consent").put("provider", "meta").put("model", "muse-spark-1.3").put("policyVersion", "meta-standard.2026-11-03");
        return b;
    }

    static ReviewRequest validated(JsonNode body) {
        return validated(body.toString());
    }

    static ReviewRequest validated(String text) {
        return ReviewRequest.validated(text, CAPS, SCHEMAS, "meta", "muse-spark-1.3", "meta-standard.2026-11-03", turnId -> { });
    }

    /**
     * The independent review of EA6.4: the turn's owner is asked once its id is read, before anything costly, so a turn
     * that is not the caller's has none of its frames decoded; a consent to other terms is refused before it is asked.
     */
    @Test
    void theOwnerIsAskedBeforeAnythingCostly() {
        byte[] bare = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xC0, 0x00, 0x08, 0x08, 0x01, (byte) 0xB0, 0x03, 0x00, (byte) 0xFF, (byte) 0xD9};
        ObjectNode b = request();
        frames(b, 0).put("jpeg", Base64.getEncoder().encodeToString(bare)).put("sha256", ReviewRequest.sha256(bare));
        List<String> asked = new ArrayList<>();
        Consumer<String> notTheirs = turnId -> {
            asked.add(turnId);
            throw new ForgeException(ErrorCode.NOT_FOUND, "This turn isn't available.");
        };
        assertThatThrownBy(() -> ReviewRequest.validated(b.toString(), CAPS, SCHEMAS, "meta", "muse-spark-1.3", "meta-standard.2026-11-03", notTheirs))
                .isInstanceOf(ForgeException.class).satisfies(e -> assertThat(((ForgeException) e).code()).isEqualTo(ErrorCode.NOT_FOUND));
        assertThat(asked).containsExactly(TURN);
        // The owner's own turn: then the frame is judged.
        assertThatThrownBy(() -> validated(b)).hasMessageContaining("is not a whole JPEG");
        // A consent to another policy: refused first, the owner never asked.
        ((ObjectNode) b.path("consent")).put("policyVersion", "meta-standard.2026-10-01");
        asked.clear();
        assertThatThrownBy(() -> ReviewRequest.validated(b.toString(), CAPS, SCHEMAS, "meta", "muse-spark-1.3", "meta-standard.2026-11-03", notTheirs))
                .hasMessageContaining("ask the creator again");
        assertThat(asked).isEmpty();
    }

    static void refused(Consumer<ObjectNode> change, ErrorCode code, String says) {
        ObjectNode b = request();
        change.accept(b);
        assertThatThrownBy(() -> validated(b)).isInstanceOf(ForgeException.class)
                .satisfies(e -> assertThat(((ForgeException) e).code()).as(e.getMessage()).isEqualTo(code))
                .hasMessageContaining(says)
                // No refusal echoes a frame's bytes (coding principles §11): never a run of base64.
                .satisfies(e -> assertThat(e.getMessage()).doesNotContainPattern("[A-Za-z0-9+/]{80}"));
    }

    static ObjectNode frames(ObjectNode b, int i) {
        return (ObjectNode) b.path("frames").get(i);
    }

    @Test
    void aWholeRequestPassesWithItsFramesDecodedAndHashed() {
        ReviewRequest r = validated(request());
        assertThat(r.reviewId()).isEqualTo("review-1");
        assertThat(r.frames()).hasSize(2);
        assertThat(r.frames().get(0).view()).isEqualTo("framed");
        assertThat(r.frames().get(0).jpeg()).isEqualTo(JPEG);
        assertThat(r.frames().get(0).tick()).isEqualTo(42);
        assertThat(r.modules()).containsExactly("castlePlace", "flagFlutter");
        assertThat(r.hostFindings()).hasSize(1);
        ReviewRequest.Jpeg whole = ReviewRequest.jpeg(JPEG);
        assertThat(new int[]{whole.width(), whole.height(), whole.components(), whole.scans()}).containsExactly(768, 432, 3, 1);
        assertThat(ReviewRequest.undecodable(whole)).isNull();
    }

    @Test
    void eachFrameIsAtMostItsBytesAndTheTwoAtMostTheirsAsTheyTravelInBase64() {
        // At the cap: two frames of 300,000 bytes, 600,000 together, as 400,000 base64 characters each.
        ObjectNode b = request();
        byte[] big = padded(JPEG, ReviewRequest.MAX_JPEG_BYTES);
        byte[] big2 = padded(VisionProbe.frame(false), ReviewRequest.MAX_JPEG_BYTES);
        ((ArrayNode) b.path("frames")).set(0, frame("review-1.v1", "framed", big));
        ((ArrayNode) b.path("frames")).set(1, frame("review-1.v2", "side", big2));
        assertThat(frames(b, 0).path("jpeg").asText()).hasSize(400_000);
        assertThat(b.toString().length()).isLessThan(ReviewRequest.MAX_REQUEST_BYTES);
        ReviewRequest r = validated(b);
        assertThat(r.frames().get(0).jpeg()).hasSize(300_000);
        assertThat(r.frames().get(1).jpeg()).hasSize(300_000);
        // One byte more: refused as too large, before its bytes are judged.
        refused(x -> ((ArrayNode) x.path("frames")).set(0, frame("review-1.v1", "framed", padded(JPEG, ReviewRequest.MAX_JPEG_BYTES + 1))),
                ErrorCode.TOO_LARGE, "EA_REVIEW_SIZE frames[0].jpeg");
    }

    @Test
    void theWholeBodyIsAtMostItsBytesBase64AndJsonIncluded() {
        ObjectNode b = request();
        String text = b.toString();
        String over = text.substring(0, text.length() - 1) + ",\"pad\":\"" + "x".repeat(ReviewRequest.MAX_REQUEST_BYTES - text.length()) + "\"}";
        assertThat(over.length()).isGreaterThan(ReviewRequest.MAX_REQUEST_BYTES);
        assertThatThrownBy(() -> validated(over)).isInstanceOf(ForgeException.class)
                .satisfies(e -> assertThat(((ForgeException) e).code()).isEqualTo(ErrorCode.TOO_LARGE));
    }

    @Test
    void aFrameIsAWhole768By432JpegWhoseHashIsItsOwn() {
        // Not a JPEG: the bytes start otherwise.
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, (byte) 0xFF, (byte) 0xD9};
        refused(b -> frames(b, 0).put("jpeg", Base64.getEncoder().encodeToString(png)).put("sha256", ReviewRequest.sha256(png)),
                ErrorCode.BAD_REQUEST, "is not a whole JPEG");
        // Cut short: no end of image.
        byte[] cut = Arrays.copyOf(JPEG, JPEG.length - 100);
        refused(b -> frames(b, 0).put("jpeg", Base64.getEncoder().encodeToString(cut)).put("sha256", ReviewRequest.sha256(cut)),
                ErrorCode.BAD_REQUEST, "is not a whole JPEG");
        // Another size: its frame header says so.
        byte[] other = JPEG.clone();
        int sof = sof(other);
        other[sof + 5] = 0x01;
        other[sof + 6] = (byte) 0xE0;
        refused(b -> frames(b, 0).put("jpeg", Base64.getEncoder().encodeToString(other)).put("sha256", ReviewRequest.sha256(other)),
                ErrorCode.BAD_REQUEST, "768 × 480; a review frame is 768 × 432");
        // Not the bytes the browser hashed.
        refused(b -> frames(b, 0).put("sha256", HASH), ErrorCode.BAD_REQUEST, "is not the SHA-256 of its JPEG");
        // The fields say another size.
        refused(b -> frames(b, 0).put("width", 1280), ErrorCode.BAD_REQUEST, "is 768 × 432 (Q108)");
    }

    /**
     * The outside review of EA6.4: a frame must be a whole image, not only a JPEG's start, a frame header saying 768 × 432
     * and an end. Its structure is walked whole (one 8-bit frame of one or three components, then its scans, at most 16,
     * then its end and nothing after), and its image is decoded, a decoder's warning (a cut or corrupt scan) as much a
     * refusal as its error, before any record or charge.
     */
    @Test
    void aFrameIsAWholeImageNotOnlyAHeaderBetweenAStartAndAnEnd() {
        // The review's own bytes: a start, a frame header of 768 × 432 cut before its components, an end.
        byte[] bare = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xC0, 0x00, 0x08, 0x08, 0x01, (byte) 0xB0, 0x03, 0x00, (byte) 0xFF, (byte) 0xD9};
        refusedJpeg(bare, "is not a whole JPEG: a segment past its end");
        int sos = marker(JPEG, 0xDA);
        int data = sos + 2 + (((JPEG[sos + 2] & 0xFF) << 8) | (JPEG[sos + 3] & 0xFF));
        // Its tables and its frame header, then no scan.
        refusedJpeg(join(Arrays.copyOf(JPEG, sos), EOI), "is not a whole JPEG: no scan");
        // A scan's header with no data after it.
        refusedJpeg(join(Arrays.copyOf(JPEG, data), EOI), "is not a whole JPEG: a scan with no data");
        // The scan cut half way, its end put back: the structure holds, the image does not decode whole.
        refusedJpeg(join(Arrays.copyOf(JPEG, data + (JPEG.length - data) / 2), EOI), "does not decode whole: Corrupt JPEG data");
        // The scan's data corrupt (noise with no 0xFF in it, so no marker): the structure holds, the decoder warns.
        byte[] corrupt = JPEG.clone();
        for (int k = data + 16; k < Math.min(corrupt.length - 64, data + 4016); k++) {
            corrupt[k] = (byte) ((k * 37) % 254);
        }
        refusedJpeg(corrupt, "does not decode whole: Corrupt JPEG data");
        // No quantization table: every segment fits, and the decoder has nothing to scale the scan by.
        refusedJpeg(without(JPEG, 0xDB), "does not decode whole: Quantization table");
        // 12-bit samples, or four components: not what a browser's canvas writes.
        byte[] twelve = JPEG.clone();
        twelve[sof(twelve) + 4] = 12;
        refusedJpeg(twelve, "is not a whole JPEG: 12-bit samples");
        // A frame header whose length is not its components'.
        byte[] cut = JPEG.clone();
        cut[sof(cut) + 3] = 0x0B;
        refusedJpeg(cut, "is not a whole JPEG: a frame header of 11 bytes for 3 components");
        // A second frame header, or a second image after the first one's end.
        int frame = sof(JPEG);
        refusedJpeg(join(Arrays.copyOf(JPEG, sos), Arrays.copyOfRange(JPEG, frame, frame + 19), Arrays.copyOfRange(JPEG, sos, JPEG.length)),
                "is not a whole JPEG: a second frame header");
        refusedJpeg(join(JPEG, JPEG), "is not a whole JPEG: bytes after its end of image");
        // Arithmetic coding (SOF9): no browser writes it.
        byte[] arithmetic = JPEG.clone();
        arithmetic[frame + 1] = (byte) 0xC9;
        refusedJpeg(arithmetic, "is not a whole JPEG: marker FFC9");
        // Seventeen scans: past what any encoder a browser has writes, and a decoder's work grows with each.
        refusedJpeg(scans(17), "has 17 scans; at most 16");
        // Sixteen pass the walk: their data is the decoder's to judge, and a byte of it is no image.
        assertThat(ReviewRequest.jpeg(scans(16)).scans()).isEqualTo(16);
        refusedJpeg(scans(16), "does not decode whole");
        // The real frames still pass, whole.
        assertThat(ReviewRequest.undecodable(ReviewRequest.jpeg(JPEG))).isNull();
        assertThat(ReviewRequest.undecodable(ReviewRequest.jpeg(VisionProbe.frame(false)))).isNull();
    }

    /**
     * What a browser writes passes: Chrome's own JPEG of a captured castle (EA-G3, the AMD GPU, 2026-11-02), with its JFIF
     * header and its sRGB colour profile (APP2). A colour profile the runtime cannot read is metadata, not a broken image:
     * the decoder is given the image's own segments only, so it does not refuse the frame (whole, it warns "Embedded
     * color profile is invalid").
     */
    @Test
    void aBrowsersFramePassesAndItsColourProfileIsNotJudged() throws IOException {
        byte[] chrome;
        try (InputStream in = ReviewRequestTest.class.getResourceAsStream("/agent/review-frames/chrome-castle-framed.jpg")) {
            chrome = in.readAllBytes();
        }
        ReviewRequest.Jpeg whole = ReviewRequest.jpeg(chrome);
        assertThat(new int[]{whole.width(), whole.height(), whole.components(), whole.scans()}).containsExactly(768, 432, 3, 1);
        assertThat(ReviewRequest.undecodable(whole)).isNull();
        // Its metadata (APP0, APP2) is walked and left out of what is decoded.
        assertThat(whole.image().length).isEqualTo(chrome.length - 18 - 474);
        ObjectNode b = request();
        ((ArrayNode) b.path("frames")).set(0, frame("review-1.v1", "framed", chrome));
        assertThat(validated(b).frames().get(0).jpeg()).isEqualTo(chrome);
        // Its colour profile garbled after its tag: still the same image, still passed.
        int app2 = marker(chrome, 0xE2);
        byte[] garbled = chrome.clone();
        Arrays.fill(garbled, app2 + 4 + 14 + 8, app2 + 2 + (((chrome[app2 + 2] & 0xFF) << 8) | (chrome[app2 + 3] & 0xFF)), (byte) 0x5A);
        ObjectNode g = request();
        ((ArrayNode) g.path("frames")).set(0, frame("review-1.v1", "framed", garbled));
        assertThat(validated(g).frames().get(0).jpeg()).isEqualTo(garbled);
    }

    static final byte[] EOI = {(byte) 0xFF, (byte) 0xD9};

    static void refusedJpeg(byte[] jpeg, String says) {
        refused(b -> frames(b, 0).put("jpeg", Base64.getEncoder().encodeToString(jpeg)).put("sha256", ReviewRequest.sha256(jpeg)),
                ErrorCode.BAD_REQUEST, says);
    }

    static byte[] join(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }

    /** The offset of the first segment whose marker is FF `code`, walking the segments before the first scan. */
    static int marker(byte[] b, int code) {
        for (int i = 2; i + 3 < b.length; ) {
            if ((b[i + 1] & 0xFF) == code) {
                return i;
            }
            if ((b[i + 1] & 0xFF) == 0xDA) {
                break;
            }
            i += 2 + (((b[i + 2] & 0xFF) << 8) | (b[i + 3] & 0xFF));
        }
        throw new AssertionError("no marker FF" + Integer.toHexString(code).toUpperCase() + " before the first scan");
    }

    /** `jpeg` without its segments of marker FF `code` before its first scan. */
    static byte[] without(byte[] jpeg, int code) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(jpeg, 0, 2);
        int i = 2;
        while ((jpeg[i + 1] & 0xFF) != 0xDA) {
            int end = i + 2 + (((jpeg[i + 2] & 0xFF) << 8) | (jpeg[i + 3] & 0xFF));
            if ((jpeg[i + 1] & 0xFF) != code) {
                out.write(jpeg, i, end - i);
            }
            i = end;
        }
        out.write(jpeg, i, jpeg.length - i);
        return out.toByteArray();
    }

    /** A JPEG's structure with `n` scans of one byte each: a start, a progressive 768 × 432 frame of three components, the scans, an end. */
    static byte[] scans(int n) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(new byte[]{(byte) 0xFF, (byte) 0xD8});
        out.writeBytes(new byte[]{(byte) 0xFF, (byte) 0xC2, 0x00, 0x11, 0x08, 0x01, (byte) 0xB0, 0x03, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01});
        for (int s = 0; s < n; s++) {
            out.writeBytes(new byte[]{(byte) 0xFF, (byte) 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0x2A});
        }
        out.writeBytes(EOI);
        return out.toByteArray();
    }

    @Test
    void aFrameIsNeverAUrlOrADataUrl() {
        refused(b -> frames(b, 0).put("jpeg", "https://example.com/castle.jpg"), ErrorCode.BAD_REQUEST, "never a URL or a data URL");
        refused(b -> frames(b, 0).put("jpeg", "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(JPEG)), ErrorCode.BAD_REQUEST,
                "never a URL or a data URL");
        refused(b -> frames(b, 0).put("jpeg", Base64.getUrlEncoder().encodeToString(JPEG)), ErrorCode.BAD_REQUEST, "standard padded base64");
    }

    @Test
    void oneOrTwoFramesEachViewOnceEachIdItsOwn() {
        refused(b -> ((ArrayNode) b.path("frames")).removeAll(), ErrorCode.BAD_REQUEST, "frames is 1 or 2");
        refused(b -> ((ArrayNode) b.path("frames")).add(frame("review-1.v3", "side", JPEG)), ErrorCode.BAD_REQUEST, "frames is 1 or 2");
        refused(b -> frames(b, 1).put("view", "framed"), ErrorCode.BAD_REQUEST, "view is framed or side, each at most once");
        refused(b -> frames(b, 1).put("id", "review-1.v1"), ErrorCode.BAD_REQUEST, "each frame's is its own");
        refused(b -> frames(b, 0).put("view", "top"), ErrorCode.BAD_REQUEST, "view is framed or side");
        refused(b -> frames(b, 0).put("remote", "https://example.com"), ErrorCode.BAD_REQUEST, "frames[0] takes exactly");
        // One frame is a review too: a world with no subject has no side view.
        ObjectNode one = request();
        ((ArrayNode) one.path("frames")).remove(1);
        assertThat(validated(one).frames()).hasSize(1);
    }

    @Test
    void theConsentIsToThisServersProviderModelAndPolicy() {
        refused(b -> ((ObjectNode) b.path("consent")).put("policyVersion", "meta-standard.2026-10-01"), ErrorCode.BAD_REQUEST, "ask the creator again");
        refused(b -> ((ObjectNode) b.path("consent")).put("model", "muse-spark-1.3-contributor"), ErrorCode.BAD_REQUEST, "ask the creator again");
        refused(b -> ((ObjectNode) b.path("consent")).put("provider", "another"), ErrorCode.BAD_REQUEST, "ask the creator again");
        refused(b -> b.remove("consent"), ErrorCode.BAD_REQUEST, "consent missing");
    }

    @Test
    void theSubjectIsASealedCandidatesNeverAModules() {
        refused(b -> ((ObjectNode) b.path("subject")).putNull("candidate"), ErrorCode.BAD_REQUEST, "a review is of a sealed candidate");
        refused(b -> ((ObjectNode) b.path("subject")).put("module", "castlePlace"), ErrorCode.BAD_REQUEST, "not one module");
        refused(b -> b.put("turnId", "turn-1"), ErrorCode.BAD_REQUEST, "turnId is the turn");
    }

    @Test
    void rAndSAreATurnsAndTheModulesAndFindingsAreBounded() {
        refused(b -> ((ObjectNode) b.path("request")).put("prompt", "x".repeat(601)), ErrorCode.TOO_LARGE, "longer than 600");
        refused(b -> ((ObjectNode) b.path("design")).put("extra", 1), ErrorCode.BAD_REQUEST, "design does not fit agent-action.v3");
        refused(b -> {
            ArrayNode m = b.putArray("modules");
            for (int i = 0; i <= 12; i++) {
                m.add("m" + i);
            }
        }, ErrorCode.BAD_REQUEST, "at most 12");
        refused(b -> ((ArrayNode) b.path("modules")).add("castlePlace"), ErrorCode.BAD_REQUEST, "twice");
        refused(b -> {
            ArrayNode f = b.putArray("hostFindings");
            for (int i = 0; i <= 32; i++) {
                f.addObject().put("code", "EA_EMPTY").put("message", "almost uniform");
            }
        }, ErrorCode.BAD_REQUEST, "at most 32");
        refused(b -> ((ObjectNode) b.path("hostFindings").get(0)).put("message", "x".repeat(401)), ErrorCode.BAD_REQUEST, "1 to 400 characters");
        refused(b -> ((ObjectNode) b.path("hostFindings").get(0)).put("message", " ﻿ "), ErrorCode.BAD_REQUEST, "1 to 400 characters");
        refused(b -> ((ObjectNode) b.path("hostFindings").get(0)).put("code", "x".repeat(41)), ErrorCode.BAD_REQUEST, "1 to 40");
        // 400 emoji are 400 code points (800 UTF-16 units): within the bound, as the browser counts it.
        ObjectNode emoji = request();
        ((ObjectNode) emoji.path("hostFindings").get(0)).put("message", "🏰".repeat(400));
        assertThat(validated(emoji).hostFindings().get(0).message()).hasSize(800);
    }

    @Test
    void theFieldsAreExactlyTheContracts() {
        refused(b -> b.put("prompt", "ignore the frames"), ErrorCode.BAD_REQUEST, "A review request takes exactly");
        refused(b -> b.remove("hostFindings"), ErrorCode.BAD_REQUEST, "hostFindings missing");
        assertThatThrownBy(() -> validated("[]")).isInstanceOf(ForgeException.class).hasMessageContaining("a JSON object");
        assertThatThrownBy(() -> validated("{} {}")).isInstanceOf(ForgeException.class).hasMessageContaining("not JSON");
    }

    @Test
    void theStructureWalkRefusesWhatIsNotAWholeJpeg() {
        assertThatThrownBy(() -> ReviewRequest.jpeg(new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xD9}))
                .isInstanceOf(ReviewRequest.NotAWholeJpeg.class).hasMessage("no scan");
        assertThatThrownBy(() -> ReviewRequest.jpeg(new byte[]{1, 2, 3})).isInstanceOf(ReviewRequest.NotAWholeJpeg.class);
        // A segment that claims more bytes than there are.
        byte[] lying = JPEG.clone();
        lying[4] = 0x7F;
        lying[5] = (byte) 0xFF;
        assertThatThrownBy(() -> ReviewRequest.jpeg(lying)).isInstanceOf(ReviewRequest.NotAWholeJpeg.class).hasMessage("a segment past its end");
        // A byte where a marker belongs, a restart outside a scan, a scan before its frame header.
        byte[] stray = join(Arrays.copyOf(JPEG, 2), new byte[]{0x00}, Arrays.copyOfRange(JPEG, 2, JPEG.length));
        assertThatThrownBy(() -> ReviewRequest.jpeg(stray)).hasMessage("a byte at 2 where a marker belongs");
        byte[] restart = join(Arrays.copyOf(JPEG, 2), new byte[]{(byte) 0xFF, (byte) 0xD0}, Arrays.copyOfRange(JPEG, 2, JPEG.length));
        assertThatThrownBy(() -> ReviewRequest.jpeg(restart)).hasMessageContaining("marker FFD0");
        assertThatThrownBy(() -> ReviewRequest.jpeg(without(JPEG, 0xC0))).hasMessage("a scan before its frame header");
        // Comments that fill a frame to 70,000 more bytes: walked over, and left out of what is decoded.
        ReviewRequest.Jpeg padded = ReviewRequest.jpeg(padded(JPEG, JPEG.length + 70_000));
        assertThat(new int[]{padded.width(), padded.height(), padded.scans()}).containsExactly(768, 432, 1);
        assertThat(padded.image()).isEqualTo(ReviewRequest.jpeg(JPEG).image());
    }

    /** The offset of the frame header's marker (FF C0 to CF but C4, C8, CC) in a JPEG. */
    static int sof(byte[] b) {
        for (int i = 2; i + 3 < b.length; ) {
            int marker = b[i + 1] & 0xFF;
            int length = ((b[i + 2] & 0xFF) << 8) | (b[i + 3] & 0xFF);
            if (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
                return i;
            }
            i += 2 + length;
        }
        throw new AssertionError("no frame header");
    }
}
