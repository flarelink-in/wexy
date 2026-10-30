package ai.wexy.forge.templates;

import java.util.Set;

/**
 * Words WGSL will not take as names: its keywords and the reserved words Dawn refused as identifiers on 2026-10-27
 * (the forge-loop design, Results, B0.1), plus {@code quality}, the host's own uniform. One set for the backend: the
 * plan's controls (`DraftChecks`) and the agent's module names (`ProgramCheck`) both refuse them. The frontend's
 * {@code src/contract/reserved.ts} holds the same words.
 */
public final class WgslWords {

    public static final Set<String> RESERVED = Set.of(
            "abstract", "active", "alias", "alignas", "alignof", "as", "asm", "async", "attribute", "auto", "await",
            "become", "break", "case", "cast", "catch", "class", "coherent", "common", "compile", "concept", "const",
            "constexpr", "continue", "continuing", "crate", "debugger", "decltype", "default", "delete", "demote",
            "diagnostic", "discard", "do", "else", "enable", "enum", "explicit", "export", "extends", "extern",
            "external", "fallthrough", "false", "filter", "final", "finally", "fn", "for", "friend", "from", "fxgroup",
            "get", "goto", "groupshared", "highp", "if", "impl", "implements", "import", "inline", "instanceof",
            "interface", "layout", "let", "loop", "lowp", "macro", "match", "mediump", "meta", "mod", "module",
            "move", "mut", "mutable", "namespace", "new", "nil", "noinline", "nointerpolation", "noperspective", "null",
            "of", "operator", "override", "package", "packoffset", "partition", "pass", "patch", "pixelfragment",
            "precise", "precision", "premerge", "priv", "protected", "pub", "public", "quality", "readonly", "ref",
            "regardless", "register", "require", "requires", "resource", "restrict", "return", "self", "set", "shared",
            "sizeof", "smooth", "snorm", "static", "std", "struct", "subroutine", "super", "switch", "target",
            "template", "this", "throw", "trait", "true", "try", "type", "typedef", "typename", "typeof", "union",
            "unless", "unorm", "unsafe", "unsized", "use", "using", "var", "varying", "virtual", "volatile", "wgsl",
            "where", "while", "with", "writeonly", "yield");

    private WgslWords() {
    }
}
