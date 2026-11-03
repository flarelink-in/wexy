package ai.wexy.platform;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Duration;

/**
 * A real MariaDB for the platform's database tests (W2), the version compose runs (11.4), made the way compose makes
 * it: one database and one account, from the image's environment. Testcontainers' generic container, so no further
 * module is needed. The image's first start initialises behind skip-networking, so the port opens only when it is
 * ready; a connection is still awaited before a test is handed the address.
 */
public final class TestDatabase {

    public static final String DATABASE = "wexy_platform";
    public static final String USER = "wexy_platform";
    public static final String PASSWORD = "test-not-a-secret";
    /** Root, for a test that reads InnoDB's own state (lock waits, the deadlock count). */
    public static final String ROOT_PASSWORD = "root-test-not-a-secret";

    private TestDatabase() {
    }

    public static GenericContainer<?> container() {
        return new GenericContainer<>(DockerImageName.parse("mariadb:11.4"))
                .withEnv("MARIADB_ROOT_PASSWORD", ROOT_PASSWORD)
                .withEnv("MARIADB_DATABASE", DATABASE)
                .withEnv("MARIADB_USER", USER)
                .withEnv("MARIADB_PASSWORD", PASSWORD)
                .withExposedPorts(3306)
                .waitingFor(Wait.forListeningPort().withStartupTimeout(Duration.ofMinutes(3)));
    }

    public static String url(GenericContainer<?> mariadb) {
        return "jdbc:mariadb://" + mariadb.getHost() + ":" + mariadb.getMappedPort(3306) + "/" + DATABASE;
    }

    /** Waits until the database takes a connection: the port can open a moment before the server answers. */
    public static void awaitConnection(GenericContainer<?> mariadb) {
        long deadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
        SQLException last = null;
        while (System.nanoTime() < deadline) {
            try (Connection ignored = DriverManager.getConnection(url(mariadb), USER, PASSWORD)) {
                return;
            } catch (SQLException e) {
                last = e;
                try {
                    Thread.sleep(500);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
        }
        throw new IllegalStateException("MariaDB never took a connection", last);
    }
}
