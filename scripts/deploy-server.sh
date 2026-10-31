#!/usr/bin/env bash
# Runs on the deployment server, over SSH from .github/workflows/deploy-server.yml:
#   ssh user@host bash -s -- IMAGE DIR < scripts/deploy-server.sh
# DIR holds the server's docker-compose.yml (whose pistead service has `image: ${PISTEAD_IMAGE...}`) and its .env.
# Pulls IMAGE, records it as PISTEAD_IMAGE in .env (so a later `docker compose up -d` keeps it), recreates the pistead
# service with it and waits for the container's health check. Migrations run when the new container starts, so a failed
# deploy is not rolled back automatically: an older server may not read the migrated database.
set -euo pipefail

image=${1:?image}
dir=${2:?directory}
timeout=${DEPLOY_HEALTH_TIMEOUT:-180}

cd "$dir"
[ -f .env ] || { echo "No .env in $(pwd): set up the server as README.md's \"Docker\" says first." >&2; exit 1; }

echo "Pulling $image"
docker pull --quiet "$image"

if grep -q '^PISTEAD_IMAGE=' .env; then
  sed -i "s|^PISTEAD_IMAGE=.*|PISTEAD_IMAGE=$image|" .env
else
  printf '\nPISTEAD_IMAGE=%s\n' "$image" >> .env
fi

# The compose file must take the image from PISTEAD_IMAGE, or the service would keep running another one.
if ! docker compose config --images | grep -qxF "$image"; then
  echo "docker-compose.yml in $(pwd) does not run PISTEAD_IMAGE: set the pistead service's image to \${PISTEAD_IMAGE:-pistead}." >&2
  exit 1
fi

previous=$(docker compose ps -q pistead 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)
echo "Previous image: ${previous:-none}"

docker compose up -d --no-build pistead

container=$(docker compose ps -q pistead)
want=$(docker image inspect -f '{{.Id}}' "$image")
have=$(docker inspect -f '{{.Image}}' "$container")
if [ "$want" != "$have" ]; then
  echo "The pistead container runs $have, not $image ($want)." >&2
  exit 1
fi

echo "Waiting up to ${timeout}s for the container to become healthy"
for _ in $(seq 1 "$timeout"); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  case "$status" in
    healthy)
      echo "Deployed $image"
      exit 0
      ;;
    unhealthy|none)
      break
      ;;
  esac
  [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || { status=exited; break; }
  sleep 1
done

echo "The pistead container is ${status:-not healthy} after deploying $image; its latest logs:" >&2
docker compose logs --tail 100 pistead >&2 || true
echo "To go back, deploy the previous image (${previous:-unknown}) once you know it reads the current database." >&2
exit 1
