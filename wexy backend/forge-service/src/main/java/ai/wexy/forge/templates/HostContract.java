package ai.wexy.forge.templates;

import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.core.io.support.ResourcePatternResolver;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The host contract the model writes against, {@code host/h1} in resources (forge-loop design
 * §5.5): the two views a model sees (the particle pass's and the sky pass's), the rules of the
 * Standard setting, the helper library the browser compiles in front of every function, and two
 * exemplars of each function.
 *
 * <p>This repository owns these files (Q28); the frontend embeds the same ones at FE1, and each side
 * pins the other's hash. A view lists every helper of {@code helpers.wgsl} with the same signature
 * (HostContractTest). Changing what any of them says or does changes what recorded functions mean,
 * so it is a new host version, never an edit of h1.
 *
 * <p>An exemplar is {@code exemplars/<world>.<function>.wgsl}: the function alone, as the model must
 * answer, and the world's plan is the mock's {@code mock/plans/<world>.json}. Startup refuses an
 * exemplar that does not begin with its {@code fn} line, and a function with fewer than two.
 */
@Component
public class HostContract {

    public static final String VERSION = "h1";

    /** The functions a model writes, in the order the studio asks for them. */
    public static final List<String> FUNCTIONS = List.of("evolve", "look", "sky");

    private static final String BASE = "classpath:host/" + VERSION + "/";

    private final String particles;
    private final String sky;
    private final String rules;
    private final String helpers;
    private final Map<String, List<Exemplar>> exemplars;

    /** One example function: the world it comes from, which function it is, and its code. */
    public record Exemplar(String world, String fn, String code) {
    }

    public HostContract() {
        this(new PathMatchingResourcePatternResolver());
    }

    HostContract(ResourcePatternResolver resources) {
        this.particles = read(resources.getResource(BASE + "particles.wgsl"));
        this.sky = read(resources.getResource(BASE + "sky.wgsl"));
        this.rules = read(resources.getResource(BASE + "rules.md"));
        this.helpers = read(resources.getResource(BASE + "helpers.wgsl"));
        List<Exemplar> found = new ArrayList<>();
        try {
            for (Resource file : resources.getResources(BASE + "exemplars/*.wgsl")) {
                found.add(exemplar(file));
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot list " + BASE + "exemplars/", e);
        }
        this.exemplars = found.stream()
                .sorted(Comparator.comparing(Exemplar::world))
                .collect(Collectors.groupingBy(Exemplar::fn, Collectors.toUnmodifiableList()));
        for (String fn : FUNCTIONS) {
            if (exemplars(fn).size() < 2) {
                throw new IllegalStateException(BASE + "exemplars/ holds " + exemplars(fn).size() + " exemplars of "
                        + fn + "; every function needs two (forge-loop design §5.5).");
            }
        }
    }

    private static Exemplar exemplar(Resource file) {
        String name = String.valueOf(file.getFilename());
        String[] parts = name.split("\\.");
        if (parts.length != 3 || !FUNCTIONS.contains(parts[1])) {
            throw new IllegalStateException(BASE + "exemplars/" + name + " is not named <world>.<evolve|look|sky>.wgsl.");
        }
        String code = read(file);
        if (!code.startsWith("fn " + parts[1] + "(")) {
            throw new IllegalStateException(BASE + "exemplars/" + name + " must begin with \"fn " + parts[1]
                    + "(\": an exemplar is exactly what the model must answer.");
        }
        return new Exemplar(parts[0], parts[1], code);
    }

    /** A resource's text with LF line ends and no trailing blank lines, so the bytes match on every OS. */
    static String read(Resource resource) {
        try {
            return resource.getContentAsString(StandardCharsets.UTF_8).replace("\r\n", "\n").stripTrailing();
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + resource.getDescription(), e);
        }
    }

    public String version() {
        return VERSION;
    }

    /** The particle pass as the model sees it: Sim, Params, Particle, Look, the helpers, evolve and look. */
    public String particles() {
        return particles;
    }

    /** The sky pass as the model sees it: Sim, Params, the helpers and sky. */
    public String sky() {
        return sky;
    }

    public String rules() {
        return rules;
    }

    /** The helper library's code, which the browser compiles in front of every function. */
    public String helpers() {
        return helpers;
    }

    /** The view a function compiles against. */
    public String contractFor(String fn) {
        return switch (fn) {
            case "evolve", "look" -> particles;
            case "sky" -> sky;
            default -> throw new IllegalArgumentException("No function '" + fn + "' in host " + VERSION + "; known: " + FUNCTIONS);
        };
    }

    /** A function's exemplars, ordered by world. */
    public List<Exemplar> exemplars(String fn) {
        return exemplars.getOrDefault(fn, List.of());
    }
}
