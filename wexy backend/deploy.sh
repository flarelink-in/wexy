#!/usr/bin/env bash
# Test, build and push the backend's images, FlareLink's deploy.sh pattern (pre-existing work): Maven builds and tests
# everything on this machine, Docker copies each module's jar (its Dockerfile) and pushes it. Nothing here deploys:
# the host pulls (docs/deploy-design.md §10).
#
#     bash deploy.sh                    # every image, one version: the set prod pins later
#     bash deploy.sh forge-gateway      # one image (prod's WEXY_IMAGE_TAG pins them all, so release all before pinning)
#
# Each run (the user, 2026-10-31):
#   1. Docker must be running: the Redis and MariaDB tests and the image builds need it, so a stopped Docker fails here,
#      before the tests rather than after them.
#   2. The version: the newest `org.opencontainers.image.version` label on the images' `latest` in the registry, its
#      patch bumped (0.0.4 becomes 0.0.5; the first release is 0.0.1). WEXY_VERSION=0.1.0 sets it instead.
#   3. ./mvnw clean validate install -Predis-tests: every test, nothing skipped, the Redis ones on real containers
#      (Testcontainers). A failing test stops the run before any image is built.
#   4. Each image built with two tags, the version and `latest`, then pushed: the version first, `latest` after.
#
# Dev runs `latest`; prod pins a version that ran on dev first (WEXY_IMAGE_TAG on the host). WEXY_REGISTRY overrides
# the registry (EventVision's, Q47); WEXY_DRY_RUN=1 tests and builds but pushes nothing. Runs in Git Bash on the laptop
# or in bash on the host (which then needs JDK 21, and the memory beside both stacks: deploy design Q49). Docker must
# be logged in to the registry:
#
#     docker login https://blr.vultrcr.com/eventvision
#
# The gateways on the host listen on its loopback only. From the laptop, with WEXY_SSH set to the host's login
# (user@address; kept out of this file, which is tracked):
#
#     ssh -L 8400:127.0.0.1:8500 "$WEXY_SSH"    # dev:  compose.dev.yaml, project wexy-dev, on the laptop's 8400
#     ssh -L 8600:127.0.0.1:8400 "$WEXY_SSH"    # prod: compose.prod.yaml, project wexy, on the laptop's 8600
set -euo pipefail

ALL=(forge-gateway forge-service platform-service)
if [ $# -eq 0 ]; then
    MODULES=("${ALL[@]}")
else
    MODULES=("$@")
fi
for MODULE in "${MODULES[@]}"; do
    case "$MODULE" in
        forge-gateway|forge-service|platform-service) ;;
        *) echo "usage: bash deploy.sh [forge-gateway] [forge-service] [platform-service]   (none: all three)" >&2; exit 2 ;;
    esac
done
# A registry path, not a URL: an image name cannot carry https://, so a pasted login address is trimmed.
REGISTRY=${WEXY_REGISTRY:-blr.vultrcr.com/eventvision}
REGISTRY=${REGISTRY#https://}
cd "$(dirname "$0")"

# On Windows the antivirus re-signs HTTPS, so Maven needs the Windows root store (docs/work/gotchas.md).
case "${OSTYPE:-}" in
    msys*|cygwin*) export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStoreType=Windows-ROOT" ;;
esac

if ! docker info >/dev/null 2>&1; then
    echo "docker is not running: the Redis and MariaDB tests and the image builds need it" >&2
    exit 1
fi

# The version label of an image's `latest` in the registry, or nothing when there is none. Read from the registry, so
# it is the same answer on any machine (FlareLink reads local tags, which a fresh machine does not have).
version_of() {
    if docker pull -q "$1:latest" >/dev/null 2>&1; then
        docker image inspect "$1:latest" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' 2>/dev/null || true
    fi
}
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'
if [ -n "${WEXY_VERSION:-}" ]; then
    NEW=$WEXY_VERSION
    [[ "$NEW" =~ $SEMVER ]] || { echo "WEXY_VERSION must be major.minor.patch, not $NEW" >&2; exit 2; }
    echo "version: $NEW (WEXY_VERSION)"
else
    # The newest across every image, so a release of one module never reuses another's number.
    CURRENT=$(for M in "${ALL[@]}"; do version_of "$REGISTRY/$M"; echo; done | tr -d '\r' | grep -E "$SEMVER" | sort -V | tail -n 1 || true)
    if [ -n "$CURRENT" ]; then
        IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"
        NEW="$MAJOR.$MINOR.$((PATCH + 1))"
        echo "version: the registry's newest is $CURRENT, so this release is $NEW"
    else
        NEW="0.0.1"
        echo "version: no versioned image in the registry yet, so this release is $NEW"
    fi
fi

echo "maven: clean validate install, every test, the Redis and MariaDB ones on Testcontainers"
./mvnw -B -ntp clean validate install -Predis-tests

# The labels say which build an image is: `docker image inspect <image>` on the host.
REVISION=$(git describe --always --dirty 2>/dev/null || echo unknown)
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for MODULE in "${MODULES[@]}"; do
    IMAGE="$REGISTRY/$MODULE"
    JAR=$(ls -1 "$MODULE"/target/"$MODULE"-*.jar | head -n 1)
    SIZE=$(stat -c %s "$JAR")
    if [ "$SIZE" -lt 5000000 ]; then
        echo "$JAR is $SIZE bytes: a thin jar, so the Boot repackage did not run. Is a JVM holding the file? (docs/work/gotchas.md)" >&2
        exit 1
    fi
    echo "docker: building $IMAGE:$NEW and $IMAGE:latest from $(basename "$JAR") (revision $REVISION)"
    docker build \
        --build-arg JAR="target/$(basename "$JAR")" \
        --label "org.opencontainers.image.version=$NEW" \
        --label "org.opencontainers.image.revision=$REVISION" \
        --label "org.opencontainers.image.created=$CREATED" \
        -t "$IMAGE:$NEW" \
        -t "$IMAGE:latest" \
        "./$MODULE"
done

if [ "${WEXY_DRY_RUN:-0}" = "1" ]; then
    echo "dry run: built ${MODULES[*]} as $NEW and latest, pushed nothing"
    exit 0
fi

for MODULE in "${MODULES[@]}"; do
    docker push "$REGISTRY/$MODULE:$NEW"
    docker push "$REGISTRY/$MODULE:latest"
done

echo "pushed ${MODULES[*]} as $NEW and latest. On the host (docs/deploy-design.md §10):"
echo "  dev, on latest:"
echo "    infisical run --env=dev -- docker compose -f compose.dev.yaml -f compose.platform.yaml -f compose.tunnel.yaml pull"
echo "    infisical run --env=dev -- docker compose -f compose.dev.yaml -f compose.platform.yaml -f compose.tunnel.yaml up -d"
echo "  prod, pinned, once $NEW has run on dev:"
echo "    WEXY_IMAGE_TAG=$NEW infisical run --env=prod -- docker compose -f compose.prod.yaml -f compose.tunnel.yaml up -d"
if [ ${#MODULES[@]} -lt ${#ALL[@]} ]; then
    echo "note: only ${MODULES[*]} has $NEW, and prod's WEXY_IMAGE_TAG pins every image: release all before pinning."
fi
