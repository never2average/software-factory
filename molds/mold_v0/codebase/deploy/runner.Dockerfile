# The on-premises runner (mold_v0-036; src/onprem-runner.ts, docs/on-premises-runner.md): the app's own image (the root
# Dockerfile, built from the same commit as the deployed app, so the runner has its packs, run tools, git and nftables),
# with the runner as its command. It runs as root only to reach the Docker socket the customer mounts and start a run
# container per run (src/run-container.ts); every run container drops its capabilities and switches to the run's user.
#
#   docker build -t app-api .
#   docker build -f deploy/runner.Dockerfile --build-arg BASE_IMAGE=app-api -t app-runner .
ARG BASE_IMAGE=app-api
FROM ${BASE_IMAGE}
USER 0
ENV NODE_ENV=production APP_RUNNER_STATE_DIR=/var/lib/app-runner
RUN install -d -m 700 -o root -g root /var/lib/app-runner
VOLUME ["/var/lib/app-runner"]
# No port: the runner only connects out. Its health is what the console shows (last seen), and --check.
HEALTHCHECK NONE
CMD ["node", "--import", "tsx", "src/onprem-runner.ts"]
