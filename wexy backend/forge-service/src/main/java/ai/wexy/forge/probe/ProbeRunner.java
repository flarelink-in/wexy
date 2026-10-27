package ai.wexy.forge.probe;

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
 * Runs the probe once at startup under the {@code probe} profile, writes its report to
 * {@code out/probe/} (git-ignored), prints the findings and exits with the probe's code.
 */
@Component
@ConditionalOnProperty(name = "wexy.probe.enabled", havingValue = "true")
class ProbeRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ProbeRunner.class);

    private final HourOneProbe probe;
    private final ObjectMapper json;
    private final ConfigurableApplicationContext context;

    ProbeRunner(HourOneProbe probe, ObjectMapper json, ConfigurableApplicationContext context) {
        this.probe = probe;
        this.json = json;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        ProbeReport report = probe.run();

        String stamp = ZonedDateTime.now(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        Path file = Path.of("out", "probe", "probe-" + stamp + ".json").toAbsolutePath();
        Files.createDirectories(file.getParent());
        Files.writeString(file, json.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValueAsString(report));

        StringBuilder summary = new StringBuilder("\n\nHour-one probe against ").append(report.baseUrl()).append('\n');
        report.findings().forEach(finding -> summary.append("  - ").append(finding).append('\n'));
        summary.append("Report: ").append(file).append('\n');
        log.info(summary.toString());

        int code = report.exitCode();
        System.exit(SpringApplication.exit(context, () -> code));
    }
}
