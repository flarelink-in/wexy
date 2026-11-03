package ai.wexy.forge.agent;

import ai.wexy.forge.models.ModelCatalog;
import ai.wexy.forge.schemas.JsonSchemas;
import ai.wexy.forge.spend.SpendGuard;
import ai.wexy.forge.templates.Prompt;
import ai.wexy.forge.templates.PromptBuilder;
import ai.wexy.forge.upstream.ChatChunk;
import ai.wexy.forge.upstream.ChatMessage;
import ai.wexy.forge.upstream.MeteredModelClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.Color;
import java.awt.GradientPaint;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The vision probe (EA6.4; the frontend's visual-review design §9.1, Q62's first, second and fourth gates): whether the
 * review model reads images through this service's image part, and what one frame costs. Run once under the
 * {@code vision} profile, <b>only on the user's word for spend</b>: three metered calls of the {@code review} role with
 * the {@code review.v1} template, exactly as a review sends them.
 *
 * <ol>
 *   <li>A side view of a red cube <b>floating</b> above a grey floor, for a request that says it rests on the floor. A
 *       model that reads the frame fails it with a {@code floating} issue.</li>
 *   <li>The same cube <b>resting</b> on the floor. A model that reads the frame raises no {@code floating} issue. Only
 *       both together pass: a model guessing "floating" every time fails the second.</li>
 *   <li>The first call's text with no image, whose answer is not judged: the difference of the two calls' prompt tokens is
 *       one frame's cost, and the probe recommends twice the larger measurement as {@code wexy.review.image-tokens}.</li>
 * </ol>
 *
 * The frames are drawn here (768 × 432 JPEGs, as the browser's are), so the probe needs no file and no GPU. Each call is
 * reserved before it is sent and settled to its usage, as every call is; its own reservation bounds a frame at
 * {@value #PROBE_IMAGE_TOKENS} tokens, well above Meta's "about 1,300 to 1,500" for a 1280 px image.
 */
@Component
@ConditionalOnProperty(name = "wexy.vision.enabled", havingValue = "true")
public class VisionProbe {

    /** The probe's own bound on one frame's tokens, for its reservations only: before it ran, nothing smaller is known. */
    static final long PROBE_IMAGE_TOKENS = 20_000;
    static final String REQUEST = "{\"prompt\":\"a red cube resting on a flat grey floor, seen from its side\",\"style\":\"cinematic\",\"seconds\":8}";
    static final String DESIGN = "{\"intent\":\"One red cube standing on a flat grey floor under a pale sky; the camera looks at it from the side.\","
            + "\"parts\":[{\"id\":\"cube\",\"is\":\"a red cube, one unit on each side, resting on the floor\"},"
            + "{\"id\":\"floor\",\"is\":\"a flat grey floor\"}]}";
    static final List<String> MODULES = List.of("cubePlace");
    static final String FRAME_LINE = "The side view: level with the subject's middle, from its side, at the framed view's distance; 768 × 432, black bars at"
            + " its edges are letterboxing, not the scene; drawn at the world's fixed step 0 (0.00 s).";

    /** As the review route's: text after the verdict is no verdict. */
    private static final ObjectMapper JSON = new ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final PromptBuilder prompts;
    private final MeteredModelClient models;
    private final ModelCatalog catalog;
    private final JsonSchemas schemas;
    private final boolean strict;

    public VisionProbe(PromptBuilder prompts, MeteredModelClient models, ModelCatalog catalog, JsonSchemas schemas,
                       ai.wexy.forge.loop.LoopProperties loop) {
        this.prompts = prompts;
        this.models = models;
        this.catalog = catalog;
        this.schemas = schemas;
        this.strict = loop.strictSchemas();
    }

    /** One call's outcome: its answer (or why there is none), its usage, its charge. */
    public record Call(String name, boolean image, String verdict, List<String> kinds, String problem, Long promptTokens, Long completionTokens,
                       Long reasoningTokens, Long costMicroUsd, long chargedMicroUsd, long elapsedMs) {
    }

    /**
     * What the probe found. {@code passed} only when both judged calls answered under the schema, the floating cube was
     * failed for floating and the resting one was not, and the frame's tokens were measured.
     */
    public record Report(String name, String model, String template, boolean passed, List<String> findings, List<Call> calls,
                         Long imageTokensMeasured, Long imageTokensRecommended) {

        public int exitCode() {
            return passed ? 0 : 1;
        }
    }

    public Report run(String name) {
        String model = catalog.role(ReviewHandler.ROLE).model();
        List<String> findings = new ArrayList<>();
        Call floating = call("floating", frame(true), true);
        Call resting = call("resting", frame(false), true);
        Call text = call("text-only", frame(true), false);
        List<Call> calls = List.of(floating, resting, text);

        boolean answered = floating.problem() == null && resting.problem() == null;
        boolean sawFloating = "fail".equals(floating.verdict()) && floating.kinds().contains("floating");
        boolean sawResting = resting.verdict() != null && !resting.kinds().contains("floating");
        findings.add(answered ? "transport: both frames went as image parts and both answers fit review-verdict.v1"
                : "transport: " + (floating.problem() != null ? "the floating frame: " + floating.problem() : "the resting frame: " + resting.problem()));
        findings.add(sawFloating ? "images: the floating cube was failed for floating" : "images: the floating cube was not failed for floating ("
                + floating.verdict() + ", " + floating.kinds() + ")");
        findings.add(sawResting ? "images: the resting cube raised no floating issue" : "images: the resting cube was called floating, or not answered ("
                + resting.verdict() + ", " + resting.kinds() + ")");

        Long measured = null;
        if (text.promptTokens() != null) {
            for (Call c : List.of(floating, resting)) {
                if (c.promptTokens() != null) {
                    long delta = c.promptTokens() - text.promptTokens();
                    measured = measured == null ? delta : Math.max(measured, delta);
                }
            }
        }
        Long recommended = measured == null || measured <= 0 ? null : (2 * measured + 99) / 100 * 100;
        findings.add(measured == null ? "metering: a frame's tokens could not be measured (a call reported no usage)"
                : measured <= 0 ? "metering: the frame measured " + measured + " tokens, which no image costs: not used"
                : "metering: one 768 x 432 frame measured " + measured + " prompt tokens; set WEXY_REVIEW_IMAGE_TOKENS=" + recommended + " (twice that)");
        boolean passed = answered && sawFloating && sawResting && recommended != null;
        if (passed) {
            findings.add("passed: set WEXY_REVIEW_VISION_PROBE=" + name + " and WEXY_REVIEW_IMAGE_TOKENS=" + recommended + " where the service runs");
        }
        return new Report(name, model, "review.v1", passed, findings, calls, measured, recommended);
    }

    private Call call(String name, byte[] jpeg, boolean image) {
        List<ChatMessage.Image> images = List.of(new ChatMessage.Image(jpeg, PROBE_IMAGE_TOKENS));
        Prompt prompt = prompts.review(REQUEST, DESIGN, MODULES, List.of(FRAME_LINE), List.of(), images);
        List<ChatMessage> messages = image ? prompt.messages() : List.of(prompt.messages().get(0), ChatMessage.user(prompt.user()));
        Map<String, Object> format = Map.of("type", "json_schema", "json_schema", Map.of(
                "name", JsonSchemas.REVIEW_VERDICT.replace('.', '_').replace('-', '_'), "schema", schemas.schema(JsonSchemas.REVIEW_VERDICT),
                "strict", strict));
        long started = System.nanoTime();
        StringBuilder text = new StringBuilder();
        AtomicReference<ChatChunk.Usage> usage = new AtomicReference<>();
        AtomicReference<String> finish = new AtomicReference<>();
        MeteredModelClient.Metered metered;
        try {
            metered = models.charge(ReviewHandler.ROLE, messages, new MeteredModelClient.CallOptions(null, format, null, SpendGuard.LANE_ADMIN),
                    "vision " + name).block(Duration.ofSeconds(30));
            metered.chunks().doOnNext(c -> {
                text.append(c.text());
                if (c.usage() != null) {
                    usage.set(c.usage());
                }
                if (c.finishReason() != null) {
                    finish.set(c.finishReason());
                }
            }).blockLast(Duration.ofSeconds(120));
        } catch (RuntimeException e) {
            return new Call(name, image, null, List.of(), "the call failed: " + e.getMessage(), null, null, null, null, 0, elapsed(started));
        }
        ChatChunk.Usage u = usage.get();
        Long cost = u == null ? null : catalog.costMicroUsd(metered.model(), u);
        String problem = null;
        String verdict = null;
        List<String> kinds = new ArrayList<>();
        if (image) {
            try {
                JsonNode answer = JSON.readTree(text.toString());
                List<String> problems = answer != null && answer.isObject() ? schemas.validate(JsonSchemas.REVIEW_VERDICT, answer) : List.of("not a JSON object");
                if (!problems.isEmpty()) {
                    problem = "off review-verdict.v1: " + problems.get(0);
                } else {
                    verdict = answer.path("verdict").asText();
                    answer.path("issues").forEach(i -> kinds.add(i.path("kind").asText()));
                }
            } catch (IOException e) {
                problem = "not JSON (finish_reason " + finish.get() + ")";
            }
        }
        return new Call(name, image, verdict, List.copyOf(kinds), problem, u == null ? null : u.promptTokens(), u == null ? null : u.completionTokens(),
                u == null ? null : u.reasoningTokens(), cost, metered.chargedMicroUsd(), elapsed(started));
    }

    private static long elapsed(long started) {
        return (System.nanoTime() - started) / 1_000_000;
    }

    /**
     * A side view, 768 × 432: a pale sky, a grey floor from two thirds down, and a red cube of 120 pixels, standing on the
     * floor's line or floating 120 pixels above it with its shadow on the floor below. As a JPEG at quality 0.85.
     */
    static byte[] frame(boolean floating) {
        BufferedImage image = new BufferedImage(ReviewRequest.WIDTH, ReviewRequest.HEIGHT, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setPaint(new GradientPaint(0, 0, new Color(0x9F, 0xB8, 0xD6), 0, 300, new Color(0xD8, 0xE2, 0xEC)));
            g.fillRect(0, 0, ReviewRequest.WIDTH, 300);
            g.setColor(new Color(0x55, 0x59, 0x60));
            g.fillRect(0, 300, ReviewRequest.WIDTH, ReviewRequest.HEIGHT - 300);
            g.setColor(new Color(0x3A, 0x3D, 0x42));
            g.fillOval(324, 296, 120, 16);
            int bottom = floating ? 180 : 300;
            g.setColor(new Color(0xC8, 0x1E, 0x1E));
            g.fillRect(324, bottom - 120, 120, 120);
            g.setColor(new Color(0x8C, 0x12, 0x12));
            g.drawRect(324, bottom - 120, 119, 119);
        } finally {
            g.dispose();
        }
        return jpeg(image, 0.85f);
    }

    private static byte[] jpeg(BufferedImage image, float quality) {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (MemoryCacheImageOutputStream stream = new MemoryCacheImageOutputStream(out)) {
            writer.setOutput(stream);
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(quality);
            writer.write(null, new IIOImage(image, null, null), param);
        } catch (IOException e) {
            throw new UncheckedIOException("The probe's frame could not be encoded", e);
        } finally {
            writer.dispose();
        }
        return out.toByteArray();
    }
}
