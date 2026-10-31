package ai.wexy.forge.templates;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** U4: the fence rule, which the frontend's contract module mirrors (forge-loop design §5.2). */
class CodeBlocksTest {

    private static final String FUNCTION = "fn evolve(p: Particle, i: u32) -> Particle {\n    var next = p;\n\n    return next;\n}";

    @Test
    void anUnfencedAnswerIsTheAnswer() {
        assertThat(CodeBlocks.unfence(FUNCTION)).isEqualTo(FUNCTION);
        assertThat(CodeBlocks.unfence("")).isEmpty();
    }

    @Test
    void aFencedAnswerIsTheBlocksContentWithoutTheProseAroundIt() {
        String answer = "Here is the function:\n```wgsl\n" + FUNCTION + "\n```\nIt moves every particle.";
        assertThat(CodeBlocks.unfence(answer)).isEqualTo(FUNCTION);
        assertThat(CodeBlocks.unfence("```\n" + FUNCTION + "\n```")).isEqualTo(FUNCTION);
        assertThat(CodeBlocks.unfence("  ```wgsl\n" + FUNCTION + "\n  ```")).isEqualTo(FUNCTION);
    }

    @Test
    void ofTwoBlocksTheFirstIsTheAnswer() {
        String answer = "```wgsl\n" + FUNCTION + "\n```\nOr, faster:\n```wgsl\nfn evolve(p: Particle, i: u32) -> Particle { return p; }\n```";
        assertThat(CodeBlocks.unfence(answer)).isEqualTo(FUNCTION);
    }

    /** A stream cut before its closing fence still yields what arrived; the compiler judges the rest. */
    @Test
    void aBlockWithoutItsClosingFenceRunsToTheEnd() {
        assertThat(CodeBlocks.unfence("```wgsl\nfn evolve(p: Particle, i: u32) -> Particle {\n    var next")).isEqualTo("fn evolve(p: Particle, i: u32) -> Particle {\n    var next");
    }

    @Test
    void backticksInsideALineAreNotAFence() {
        String answer = "fn look(p: Particle, i: u32) -> Look {\n    // not a ``` fence\n    var o: Look;\n    return o;\n}";
        assertThat(CodeBlocks.unfence(answer)).isEqualTo(answer);
    }
}
