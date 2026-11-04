// A saved world's versions (W3; the creations platform companion §5 and §8; Q125, the user, 2026-11-03: "keep
// versioning proper for now ... its better to go for versioning and proper controlled path"). Kept apart from the
// artifact's code, so a page that only lists worlds (`/creations`) can say which ones this build opens without loading
// the resolver.
//
// The format is the file's layout. The line is a promise: every build that lists a line runs every world saved on it as
// it was made. A change that would stop a saved world opening, or run it otherwise, starts a new line on purpose; this
// build then lists the older lines it was proved to still run (the corpus, test/fixtures/worlds/). Nothing migrates.

/** The file's layout. */
export const WORLD_FORMAT = 'wexy-world.v1';

/** The line this build writes. */
export const WORLD_LINE = 'ea.v1';

/** The lines this build opens: its own, and an older one only once the corpus proves it runs as made. */
export const OPENS_LINES: readonly string[] = Object.freeze([WORLD_LINE]);

/** A line's shape: a lower-case name, then `.v` and a number. Anything else is not a line. */
export const LINE_SHAPE = /^[a-z][a-z0-9-]{0,15}\.v[1-9][0-9]{0,3}$/;

/** Whether this build opens worlds of `line`. */
export const opensLine = (line: string): boolean => OPENS_LINES.includes(line);

/** At most this many UTF-8 bytes of text (the backend's §11). */
export const WORLD_MAX_BYTES = 512 * 1024;
