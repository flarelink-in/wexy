package ai.wexy.forge.records;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** U7: bounded, expiring, finished once, and the repair depth the escalation rule counts. */
class InMemoryGenerationStoreTest {

    private final AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-10-27T10:00:00Z"));
    private final Clock clock = new Clock() {
        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now.get();
        }
    };

    private Generation started(String id, Generation.Kind kind, String parentId) {
        return Generation.started(id, kind, parentId, "author", "m-1", "author.evolve.v1", "h1", "evolve", "{}",
                Generation.Source.USER, "uid-1", now.get());
    }

    private static Generation.Finish finish(Generation.Status status) {
        return new Generation.Finish("text", 10L, 20L, null, 100, 50L, 5L, 9L, status);
    }

    @Test
    void theOldestGoesFirstWhenTheStoreIsFull() {
        InMemoryGenerationStore store = new InMemoryGenerationStore(2, Duration.ofHours(2), clock);
        store.begin(started("a", Generation.Kind.PLAN, null));
        store.begin(started("b", Generation.Kind.PLAN, null));
        store.begin(started("c", Generation.Kind.PLAN, null));

        assertThat(store.find("a")).isEmpty();
        assertThat(store.find("b")).isPresent();
        assertThat(store.find("c")).isPresent();
    }

    @Test
    void aGenerationExpiresAfterItsTtl() {
        InMemoryGenerationStore store = new InMemoryGenerationStore(10, Duration.ofHours(2), clock);
        store.begin(started("a", Generation.Kind.PLAN, null));

        now.set(now.get().plus(Duration.ofHours(2)));
        assertThat(store.find("a")).isPresent();
        now.set(now.get().plusSeconds(1));
        assertThat(store.find("a")).isEmpty();
        store.begin(started("b", Generation.Kind.PLAN, null));
        assertThat(store.snapshot()).extracting(Generation::id).containsExactly("b");
    }

    /** I5: a call ends one way; a late cancel cannot overwrite an OK, nor a second finish the first. */
    @Test
    void onlyTheFirstFinishCounts() {
        InMemoryGenerationStore store = new InMemoryGenerationStore(10, Duration.ofHours(2), clock);
        store.begin(started("a", Generation.Kind.PLAN, null));
        store.finish("a", finish(Generation.Status.OK));
        store.finish("a", finish(Generation.Status.CANCELLED));

        Generation a = store.find("a").orElseThrow();
        assertThat(a.status()).isEqualTo(Generation.Status.OK);
        assertThat(a.output()).isEqualTo("text");
        assertThat(a.costMicroUsd()).isEqualTo(50L);
    }

    /** Escalation counts successful repairs only: author, repair ok, repair error, repair ok is two. */
    @Test
    void theRepairDepthCountsSuccessfulRepairsBackToTheAuthor() {
        InMemoryGenerationStore store = new InMemoryGenerationStore(10, Duration.ofHours(2), clock);
        store.begin(started("author", Generation.Kind.AUTHOR, "plan"));
        store.finish("author", finish(Generation.Status.OK));
        store.begin(started("r1", Generation.Kind.REPAIR, "author"));
        store.finish("r1", finish(Generation.Status.OK));
        store.begin(started("r2", Generation.Kind.REPAIR, "r1"));
        store.finish("r2", finish(Generation.Status.ERROR));
        store.begin(started("r3", Generation.Kind.REPAIR, "r2"));
        store.finish("r3", finish(Generation.Status.OK));

        assertThat(store.okRepairDepth("author")).isZero();
        assertThat(store.okRepairDepth("r1")).isEqualTo(1);
        assertThat(store.okRepairDepth("r2")).isEqualTo(1);
        assertThat(store.okRepairDepth("r3")).isEqualTo(2);
        assertThat(store.okRepairDepth("missing")).isZero();
    }

    @Test
    void idsAreUlidsInTimeOrder() {
        String first = Ulid.next(Instant.parse("2026-10-27T10:00:00Z"));
        String second = Ulid.next(Instant.parse("2026-10-27T10:00:00.001Z"));

        assertThat(first).hasSize(26).matches("[0-9A-HJKMNP-TV-Z]{26}");
        assertThat(first.compareTo(second)).isNegative();
        assertThat(Ulid.looksLikeOne(first)).isTrue();
        assertThat(Ulid.looksLikeOne("01J0000000000000000000000I")).isFalse();
        assertThat(Ulid.looksLikeOne("short")).isFalse();
        assertThat(Ulid.looksLikeOne(null)).isFalse();
    }
}
