package ai.wexy.forge.paper;

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
 * Runs the paper test once at startup under the {@code paper} profile, as {@code ProbeRunner} runs the
 * hour-one probe: writes the report to {@code out/paper/} (git-ignored), prints the findings, then
 * prints the whole report between two marker lines and exits with the test's code. The printed copy is
 * the one that survives on the host, where the run's container is removed when it exits.
 */
@Component
@ConditionalOnProperty(name = "wexy.paper.enabled", havingValue = "true")
class PaperRunner implements ApplicationRunner {

    static final String BEGIN = "===== WEXY PAPER REPORT BEGIN =====";
    static final String END = "===== WEXY PAPER REPORT END =====";

    private static final Logger log = LoggerFactory.getLogger(PaperRunner.class);

    private final PaperProbe probe;
    private final ObjectMapper json;
    private final ConfigurableApplicationContext context;

    PaperRunner(PaperProbe probe, ObjectMapper json, ConfigurableApplicationContext context) {
        this.probe = probe;
        this.json = json;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        PaperReport report = probe.run();
        String text = json.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValueAsString(report);

        String stamp = ZonedDateTime.now(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        Path file = Path.of("out", "paper", "paper-" + stamp + ".json").toAbsolutePath();
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, text);
        } catch (IOException e) {
            log.warn("The paper report could not be written to {} ({}); the printed copy below is whole.", file, e.toString());
        }

        StringBuilder summary = new StringBuilder("\n\nPaper test against ").append(report.baseUrl()).append('\n');
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
