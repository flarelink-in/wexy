package ai.wexy.forge.vision;

import ai.wexy.forge.agent.VisionProbe;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Runs the vision probe once at startup under the {@code vision} profile, as {@code PaperRunner} runs the paper test:
 * writes the report to {@code out/vision/} (git-ignored), prints its findings, then the whole report between two marker
 * lines, and exits with the probe's code. The report's name is what {@code wexy.review.vision-probe} records once it
 * passed; nothing here sets it. Its own package, as the paper test's runner has: it writes a file, which the agent
 * package never does (AgentToolsTest, A3).
 */
@Component
@ConditionalOnProperty(name = "wexy.vision.enabled", havingValue = "true")
class VisionRunner implements ApplicationRunner {

    static final String BEGIN = "===== WEXY VISION REPORT BEGIN =====";
    static final String END = "===== WEXY VISION REPORT END =====";

    private static final Logger log = LoggerFactory.getLogger(VisionRunner.class);

    private final VisionProbe probe;
    private final ObjectMapper json;
    private final ConfigurableApplicationContext context;

    VisionRunner(VisionProbe probe, ObjectMapper json, ConfigurableApplicationContext context) {
        this.probe = probe;
        this.json = json;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        String stamp = ZonedDateTime.now(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        VisionProbe.Report report = probe.run("vision-" + stamp);
        String text = json.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValueAsString(report);
        Path file = Path.of("out", "vision", report.name() + ".json").toAbsolutePath();
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, text);
        } catch (IOException e) {
            log.warn("The vision report could not be written to {} ({}); the printed copy below is whole.", file, e.toString());
        }
        StringBuilder summary = new StringBuilder("\n\nVision probe of ").append(report.model()).append(" (").append(report.template()).append(")\n");
        report.findings().forEach(finding -> summary.append("  - ").append(finding).append('\n'));
        summary.append("Report: ").append(file).append(", and printed whole between the markers below.\n");
        log.info(summary.toString());
        System.out.println(BEGIN);
        System.out.println(text);
        System.out.println(END);
        System.out.flush();
        int code = report.exitCode();
        System.exit(SpringApplication.exit(context, () -> code));
    }
}
