#!/usr/bin/env bash
# Build one image and push it, FlareLink's deploy.sh pattern (pre-existing work): Maven packages the jar on this
# machine, Docker copies it (the module's Dockerfile) and pushes it. Nothing here deploys: the host pulls
# (docs/deploy-design.md §10).
#
#     ./deploy.sh forge-gateway
#     ./deploy.sh forge-service
#
# While the product is developed (the user, 2026-10-29, Q47): EventVision's Vultr registry and the `latest` tag only,
# so each build replaces the last one and the host's `pull`, then `up -d`, takes it; the image's labels say which
# revision it is and when it was built. WEXY_VERSIONED=1 brings back numbered releases (the registry's newest version,
# bumped by one patch, pushed beside `latest`); WEXY_REGISTRY overrides the registry; WEXY_DRY_RUN=1 builds without
# pushing. Runs in Git Bash on the laptop or in bash on the host. Docker must be running and logged in:
#
#     docker login https://blr.vultrcr.com/eventvision
set -euo pipefail

MODULE=${1:-}
case "$MODULE" in
    forge-gateway|forge-service) ;;
    *) echo "usage: ./deploy.sh forge-gateway|forge-service" >&2; exit 2 ;;
esac
# A registry path, not a URL: an image name cannot carry https://, so a pasted login address is trimmed.
REGISTRY=${WEXY_REGISTRY:-blr.vultrcr.com/eventvision}
REGISTRY=${REGISTRY#https://}
cd "$(dirname "$0")"
IMAGE="$REGISTRY/$MODULE"

# On Windows the antivirus re-signs HTTPS, so Maven needs the Windows root store (docs/work/gotchas.md).
case "${OSTYPE:-}" in
    msys*|cygwin*) export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStoreType=Windows-ROOT" ;;
esac

TAGS=(-t "$IMAGE:latest")
VERSION_LABEL=()
NEW=""
if [ "${WEXY_VERSIONED:-0}" = "1" ]; then
    # The current version is the label on the registry's `latest`, so it is the same answer on any machine
    # (FlareLink reads local tags, which a fresh machine does not have).
    CURRENT=""
    if docker pull "$IMAGE:latest" >/dev/null 2>&1; then
        CURRENT=$(docker image inspect "$IMAGE:latest" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' 2>/dev/null || true)
    fi
    if [[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        NEW="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
        echo "registry has $IMAGE:$CURRENT; building $NEW"
    else
        NEW="1.0.0"
        echo "no versioned image in the registry; building $NEW"
    fi
    TAGS+=(-t "$IMAGE:$NEW")
    VERSION_LABEL=(--label "org.opencontainers.image.version=$NEW")
fi

echo "maven: packaging $MODULE (tests skipped; they run with ./mvnw -B verify)"
./mvnw -B -q -pl "$MODULE" -am package -Dmaven.test.skip=true

JAR=$(ls -1 "$MODULE"/target/"$MODULE"-*.jar | head -n 1)
SIZE=$(stat -c %s "$JAR")
if [ "$SIZE" -lt 5000000 ]; then
    echo "$JAR is $SIZE bytes: a thin jar, so the Boot repackage did not run. Is a JVM holding the file? (docs/work/gotchas.md)" >&2
    exit 1
fi

# With `latest` only, these labels are how to tell builds apart: `docker image inspect <image>` on the host.
REVISION=$(git describe --always --dirty 2>/dev/null || echo unknown)
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILT="$IMAGE:latest${NEW:+ and $IMAGE:$NEW}"
echo "docker: building $BUILT from $(basename "$JAR") (revision $REVISION)"
docker build \
    --build-arg JAR="target/$(basename "$JAR")" \
    ${VERSION_LABEL[@]+"${VERSION_LABEL[@]}"} \
    --label "org.opencontainers.image.revision=$REVISION" \
    --label "org.opencontainers.image.created=$CREATED" \
    "${TAGS[@]}" \
    "./$MODULE"

if [ "${WEXY_DRY_RUN:-0}" = "1" ]; then
    echo "dry run: built $BUILT, pushed nothing"
    exit 0
fi

if [ -n "$NEW" ]; then
    docker push "$IMAGE:$NEW"
fi
docker push "$IMAGE:latest"
echo "pushed $BUILT. On the host, with -f compose.tunnel.yaml as well once the tunnel exists:"
echo "    infisical run --env=prod -- docker compose -f compose.prod.yaml pull"
echo "    infisical run --env=prod -- docker compose -f compose.prod.yaml up -d"
