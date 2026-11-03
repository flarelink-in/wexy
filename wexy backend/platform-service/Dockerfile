# platform-service: accounts and their profiles (W2), then saved worlds and the showcase, on 8430, never published
# (only the gateway reaches it on the compose network), with the actuator on 8431 (compose.platform.yaml). Built as
# the other two are: Maven packages the jar outside Docker (deploy.sh) and this file only copies it. The migrations
# are inside the jar. A JRE, a non-root user, curl for the health check.
FROM eclipse-temurin:21-jre-jammy

ARG JAR=target/platform-service-0.1.0-SNAPSHOT.jar

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group --create-home --home-dir /app wexy

WORKDIR /app
COPY --chown=wexy:wexy ${JAR} /app/platform-service.jar
USER wexy

# As the other two's: -Xmx384m under compose's 640 MB cap, and an OutOfMemoryError ends the process so that
# `restart: unless-stopped` brings a clean one back. W2's host gate measures what it really holds.
ENV JAVA_OPTS="-Xmx384m -XX:+ExitOnOutOfMemoryError"

EXPOSE 8430 8431
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/platform-service.jar"]
