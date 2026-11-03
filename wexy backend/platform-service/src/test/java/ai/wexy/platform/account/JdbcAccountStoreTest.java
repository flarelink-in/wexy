package ai.wexy.platform.account;

import ai.wexy.platform.TestDatabase;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.identity.PlatformCaller;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PL-T3 at its source (W2): the migration and the store against a real MariaDB. Concurrent bootstraps of one subject
 * make one account; concurrent claims of one handle give it one owner, whatever its case; a stale version writes
 * nothing; a claimed handle is not overwritten, even by a write that skips the service's own check; the database's
 * own constraints refuse a client's forged values; and the account outlives the connection pool that made it (a
 * restart). Skipped, and reported as skipped, when Docker is not running.
 */
@Testcontainers(disabledWithoutDocker = true)
class JdbcAccountStoreTest {

    @Container
    private static final GenericContainer<?> MARIADB = TestDatabase.container();

    private HikariDataSource pool;
    private JdbcClient jdbc;
    private JdbcAccountStore store;
    private Accounts accounts;

    @BeforeAll
    static void migrate() {
        TestDatabase.awaitConnection(MARIADB);
        Flyway flyway = Flyway.configure().dataSource(TestDatabase.url(MARIADB), TestDatabase.USER, TestDatabase.PASSWORD)
                .locations("classpath:db/migration").load();
        flyway.migrate();
        // A second start finds the schema at its version and changes nothing.
        assertThat(flyway.migrate().migrationsExecuted).isZero();
    }

    @BeforeEach
    void open() {
        pool = pool();
        jdbc = JdbcClient.create(pool);
        jdbc.sql("DELETE FROM profile").update();
        jdbc.sql("DELETE FROM account").update();
        store = new JdbcAccountStore(jdbc, new DataSourceTransactionManager(pool));
        accounts = new Accounts(store, new SubjectKey(AccountRoutesTest.KEY, 1, true), Handle.reservedFromResource(), 1,
                Clock.systemUTC());
    }

    @AfterEach
    void close() {
        pool.close();
    }

    private static HikariDataSource pool() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(TestDatabase.url(MARIADB));
        config.setUsername(TestDatabase.USER);
        config.setPassword(TestDatabase.PASSWORD);
        config.setMaximumPoolSize(10);
        return new HikariDataSource(config);
    }

    private static PlatformCaller caller(String uid) {
        return new PlatformCaller(uid, false, "google.com");
    }

    private int count(String sql) {
        return jdbc.sql(sql).query(Integer.class).single();
    }

    @Test
    void concurrentBootstrapsOfOneSubjectMakeOneAccount() throws Exception {
        List<Accounts.Bootstrap> made = race(16, i -> accounts.bootstrap(caller("uid-1")));

        assertThat(made.stream().filter(Accounts.Bootstrap::created)).hasSize(1);
        assertThat(made.stream().map(b -> b.account().id()).distinct()).hasSize(1);
        assertThat(count("SELECT COUNT(*) FROM account")).isEqualTo(1);
        assertThat(count("SELECT COUNT(*) FROM profile")).isEqualTo(1);
        // No Firebase uid is stored anywhere: the subject is its HMAC.
        assertThat(count("SELECT COUNT(*) FROM account WHERE subject_hmac LIKE '%uid-1%'")).isZero();
    }

    /**
     * Racing writers of one unique value can deadlock in InnoDB, which rolls one back as the victim; the store tries a
     * victim again, so every loser is told the handle is taken (409), never that the service is unavailable. Several
     * rounds, since a deadlock comes only with some interleavings (the first run of this test passed without one).
     */
    @Test
    void concurrentClaimsOfOneHandleGiveItOneOwnerWhateverItsCase() throws Exception {
        for (int round = 0; round < 5; round++) {
            String handle = "nova" + round;
            List<String> uids = new ArrayList<>();
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < 12; i++) {
                uids.add("uid-" + round + "-" + i);
                ids.add(accounts.bootstrap(caller(uids.get(i))).account().id());
            }
            List<Object> outcomes = race(uids.size(), i -> {
                try {
                    return accounts.patchProfile(caller(uids.get(i)), new ProfilePatch(ids.get(i), 0,
                            i % 2 == 0 ? handle : handle.toUpperCase(), ProfilePatch.Text.ABSENT, ProfilePatch.Text.ABSENT));
                } catch (PlatformException refused) {
                    return refused.code();
                }
            });

            assertThat(outcomes.stream().filter(o -> o instanceof Account)).as("round %d", round).hasSize(1);
            assertThat(outcomes.stream().filter(o -> o == ai.wexy.common.ErrorCode.CONFLICT)).as("round %d", round)
                    .hasSize(uids.size() - 1);
            assertThat(count("SELECT COUNT(*) FROM profile WHERE handle_normalized = '" + handle + "'")).isEqualTo(1);
        }
        assertThat(count("SELECT COUNT(*) FROM profile WHERE handle_normalized IS NOT NULL")).isEqualTo(5);
    }

    /**
     * The deadlock, made on purpose (the store's retry is what this holds; the race above meets one only now and then):
     * one transaction holds a handle uncommitted, two claims of the same handle wait behind it, and it is rolled back.
     * InnoDB grants both waiters their shared locks, each then needs the other's, and one is rolled back as the victim.
     * The store tries the victim again: one claim is written and the other is told the handle is taken, never an error.
     */
    @Test
    void aDeadlocksVictimIsTriedAgainAndToldTheHandleIsTaken() throws Exception {
        String a = accounts.bootstrap(caller("uid-a")).account().id();
        String b = accounts.bootstrap(caller("uid-b")).account().id();
        String c = accounts.bootstrap(caller("uid-c")).account().id();
        try (Connection holder = DriverManager.getConnection(TestDatabase.url(MARIADB), TestDatabase.USER, TestDatabase.PASSWORD);
             Connection root = DriverManager.getConnection(TestDatabase.url(MARIADB), "root", TestDatabase.ROOT_PASSWORD)) {
            long deadlocksBefore = deadlocks(root);
            holder.setAutoCommit(false);
            try (PreparedStatement hold = holder.prepareStatement("UPDATE profile SET handle_normalized = 'race' WHERE account_id = ?")) {
                hold.setString(1, a);
                assertThat(hold.executeUpdate()).isEqualTo(1);
            }
            ExecutorService threads = Executors.newFixedThreadPool(2);
            try {
                Future<AccountStore.Write> first = threads.submit(() -> store.writeProfile(b, 0, "race", null, null, Instant.now()));
                Future<AccountStore.Write> second = threads.submit(() -> store.writeProfile(c, 0, "race", null, null, Instant.now()));
                // Time for both claims to queue on the held handle (a local database: milliseconds); the deadlock count
                // below says whether they did, so a slow start fails this test rather than passing it untested.
                Thread.sleep(1500);
                assertThat(first.isDone() || second.isDone()).as("both claims wait behind the held handle").isFalse();
                holder.rollback();
                assertThat(List.of(first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS)))
                        .containsExactlyInAnyOrder(AccountStore.Write.WRITTEN, AccountStore.Write.HANDLE_TAKEN);
            } finally {
                threads.shutdownNow();
            }
            assertThat(deadlocks(root)).as("InnoDB made a victim, and the store tried it again").isGreaterThan(deadlocksBefore);
        }
        assertThat(count("SELECT COUNT(*) FROM profile WHERE handle_normalized = 'race'")).isEqualTo(1);
    }

    private static long deadlocks(Connection root) throws SQLException {
        try (var statement = root.createStatement(); ResultSet row = statement.executeQuery("SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'")) {
            assertThat(row.next()).isTrue();
            return row.getLong(2);
        }
    }

    @Test
    void aStaleVersionOrAnInactiveAccountWritesNothing() {
        Account account = accounts.bootstrap(caller("uid-1")).account();
        assertThat(store.writeProfile(account.id(), 0, null, "Nova", null, Instant.now())).isEqualTo(AccountStore.Write.WRITTEN);
        assertThat(store.writeProfile(account.id(), 0, null, "Other", null, Instant.now())).isEqualTo(AccountStore.Write.STALE);
        assertThat(store.findBySubject(new SubjectKey(AccountRoutesTest.KEY, 1, true).lookups("uid-1")).orElseThrow().profile())
                .isEqualTo(new Account.Profile(null, "Nova", null, false, 1));

        jdbc.sql("UPDATE account SET status = 'SUSPENDED'").update();
        assertThat(store.writeProfile(account.id(), 1, null, "Other", null, Instant.now())).isEqualTo(AccountStore.Write.STALE);
        assertThat(count("SELECT COUNT(*) FROM profile WHERE display_name = 'Other'")).isZero();
    }

    /** The service refuses a change of a claimed handle; the database refuses it too, should a write skip that check. */
    @Test
    void aClaimedHandleIsNotOverwrittenEvenPastTheServicesCheck() {
        Account account = accounts.bootstrap(caller("uid-1")).account();
        assertThat(store.writeProfile(account.id(), 0, "nova", null, null, Instant.now())).isEqualTo(AccountStore.Write.WRITTEN);
        assertThat(store.writeProfile(account.id(), 1, "other", null, null, Instant.now())).isEqualTo(AccountStore.Write.STALE);
        assertThat(count("SELECT COUNT(*) FROM profile WHERE handle_normalized = 'nova'")).isEqualTo(1);
    }

    /** The columns' own rules: a forged id, subject, status or handle shape is refused by MariaDB itself. */
    @Test
    void theSchemaRefusesForgedValues() {
        Instant now = Instant.now();
        assertThatThrownBy(() -> store.create("not-a-ulid-not-a-ulid-xxxx", "a".repeat(64), 1, 1, now)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> store.create(ai.wexy.common.Ulid.next(now), "UPPER" + "a".repeat(59), 1, 1, now))
                .isInstanceOf(RuntimeException.class);
        Account account = accounts.bootstrap(caller("uid-1")).account();
        assertThatThrownBy(() -> jdbc.sql("UPDATE account SET status = 'ADMIN'").update()).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> store.writeProfile(account.id(), 0, "Nova", null, null, now)).isInstanceOf(RuntimeException.class);
        assertThat(count("SELECT COUNT(*) FROM account")).isEqualTo(1);
    }

    /** "Restart everything: the account is still there" (W2's demo), at the store: a new pool finds what the old one made. */
    @Test
    void theAccountOutlivesThePoolThatMadeIt() {
        String id = accounts.bootstrap(caller("uid-1")).account().id();
        accounts.patchProfile(caller("uid-1"), new ProfilePatch(id, 0, "nova", ProfilePatch.Text.ABSENT, ProfilePatch.Text.ABSENT));
        pool.close();

        pool = pool();
        jdbc = JdbcClient.create(pool);
        store = new JdbcAccountStore(jdbc, new DataSourceTransactionManager(pool));
        Accounts restarted = new Accounts(store, new SubjectKey(AccountRoutesTest.KEY, 1, true), Handle.reservedFromResource(), 1,
                Clock.systemUTC());
        Account read = restarted.read(caller("uid-1"));
        assertThat(read.profile().handle()).isEqualTo("nova");
        assertThat(read.profile().rowVersion()).isEqualTo(1);
        assertThat(restarted.bootstrap(caller("uid-1")).created()).isFalse();
        assertThat(count("SELECT COUNT(*) FROM account")).isEqualTo(1);
    }

    /** Runs `work` on `n` threads, all released at once, and returns what each came to. */
    private static <T> List<T> race(int n, java.util.function.IntFunction<T> work) throws Exception {
        ExecutorService threads = Executors.newFixedThreadPool(n);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<T>> tries = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                int index = i;
                tries.add(threads.submit(() -> {
                    go.await();
                    return work.apply(index);
                }));
            }
            go.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> attempt : tries) {
                results.add(attempt.get());
            }
            return results;
        } finally {
            threads.shutdownNow();
        }
    }
}
