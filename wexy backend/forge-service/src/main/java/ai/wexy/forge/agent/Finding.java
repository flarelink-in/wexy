package ai.wexy.forge.agent;

/**
 * One finding of the program check (the agent-loop design §8): a {@code fail} keeps the program from being handed
 * off and goes back to the model in a revise round; a {@code warn} is shown and kept.
 *
 * @param code    the rule: {@code name}, {@code member}, {@code arg-key}, {@code buffer-producer}…
 * @param path    where in the action: {@code program.objects.voxelBatch.args.config.shaderCode}
 * @param message what is wrong, in words the model can act on
 */
public record Finding(String level, String code, String path, String message) {

    static Finding fail(String code, String path, String message) {
        return new Finding("fail", code, path, message);
    }

    static Finding warn(String code, String path, String message) {
        return new Finding("warn", code, path, message);
    }

    public boolean fails() {
        return "fail".equals(level);
    }
}
