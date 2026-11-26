# Remote services for the GitHub Pages portal

The public frontend remains at https://tri-ctrl.github.io/GeoMap-Detector/.
Directory Files discovers its backend from `ingestion-config.json`; users never
enter a processing server or press Connect. No localhost address is embedded in
the Pages build.

GitHub Pages hosts static files and cannot execute FastAPI, Airflow, Docker tasks,
Kafka, PostgreSQL or MinIO. Additional Pages repositories do not supply backend
hosts. GitHub Container Registry stores the images, while a Docker-capable host
must run them. Codespaces can supply that host for development/retesting, but
stops on inactivity and is not an always-on production deployment.

## Build and store service images on GitHub

`.github/workflows/ingestion-images.yml` builds upload-api, Airflow, ingestion,
MinIO and the web gateway and publishes commit-SHA tags to:

```
ghcr.io/tri-ctrl/geomap-detector/upload-api:<commit-sha>
ghcr.io/tri-ctrl/geomap-detector/airflow:<commit-sha>
ghcr.io/tri-ctrl/geomap-detector/ingestion:<commit-sha>
ghcr.io/tri-ctrl/geomap-detector/minio:<commit-sha>
ghcr.io/tri-ctrl/geomap-detector/web:<commit-sha>
```

The optional container workflow runs by manual dispatch. Native ingestion has its
own automatic test workflow; see [native execution](native-ingestion.md). These are
configured destinations, not a claim that images have already been published.
The default GitHub runner builds Linux amd64 images; native local builds also
support ARM. Package visibility/access follows the repository/registry settings.

## Run on the selected remote Docker host

Use a stable HTTPS gateway origin, for example `https://files.example.com`.
Replace the example with the actual host; it is not an existing deployment.

```env
S3_PUBLIC_ENDPOINT=https://files.example.com
S3_PROXY_HOST=files.example.com
UPLOAD_CORS_ORIGIN=https://tri-ctrl.github.io,https://files.example.com
REGISTRY_PREFIX=ghcr.io/tri-ctrl/geomap-detector
IMAGE_TAG=<published-commit-sha>
```

Configure HTTPS ingress to the gateway on port 8095. nginx forwards `/api/` to the
upload API and `/geomap-files/` to MinIO, preserving signed paths, query strings
and the public Host header. PostgreSQL, Kafka and Airflow task containers remain
on the private Docker network; the browser does not need separate endpoints for
each internal service. If you use an existing managed S3 service, its public URL
and allowed frontend origin must be configured instead.

```sh
docker compose -f compose.yaml -f compose.registry.yaml pull
docker compose -f compose.yaml -f compose.registry.yaml up -d --no-build
```

The host must be able to pull the packages. The registry override also selects
the correct processor image for DockerOperator. The current application is a
single-workspace deployment; configure access control before sharing confidential
uploads with external users. Do not expose the database, Kafka or Docker socket.

### Deploy from GitHub Actions

The **Deploy ingestion services to remote Docker** workflow manages the remote
Docker engine over SSH; it runs the entire Compose stack on that host. Separate
public hosts for each internal service are unnecessary. The host needs Docker
Engine, an SSH user with Docker access, sufficient storage, and HTTPS ingress to
its loopback gateway port 8095. No source checkout is required on the server.

Configure these secrets in the GitHub `ingestion` environment:

- `INGESTION_SSH_HOST`, `INGESTION_SSH_USER`, `INGESTION_SSH_KEY` and
  `INGESTION_SSH_KNOWN_HOSTS` (the verified SSH host-key entry).
- `INGESTION_ENV_FILE`: the deployment's `.env` content, with generated
  `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `POSTGRES_PASSWORD`, `AIRFLOW_PASSWORD`,
  `AIRFLOW_SECRET_KEY` and `AIRFLOW_FERNET_KEY`. Keep these stable across deploys.
  PostgreSQL passwords must be URL-safe because they are embedded in connection
  URLs. Generate passwords with `openssl rand -hex 24`; generate the Fernet key
  with `python3 -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'`.

Set the **repository** variable `INGESTION_API_URL` to the real HTTPS gateway
origin (also used by Pages). For a nonstandard SSH port, set `INGESTION_SSH_PORT`.
Run the image build, then dispatch the deployment workflow with that build's
40-character commit SHA. It checks configuration, pulls all images, waits for
Compose readiness, and checks the API through public HTTPS. The registry login
uses the job's temporary token. Runtime volumes and restart policies live on the
remote engine. The workflow has been prepared and locally validated; it has not
been dispatched against a remote host in this session.

## Connect the Pages deployment automatically

1. In the repository's Actions variables, set `INGESTION_API_URL` to the actual
   remote HTTPS gateway origin.
2. Run the normal Pages publishing workflow.
3. The build writes `frontend/ingestion-config.json`. Deployment verification
   checks that its API URL matches the configured remote target.

An empty value keeps same-origin mode for the integrated app. On a `github.io`
site, Directory Files explicitly reports that remote services have not yet been
configured. It does not silently try the visitor's localhost.

## Full stack inside GitHub Codespaces for retesting

The default `.devcontainer/devcontainer.json` now installs native Python ingestion;
see [native execution](native-ingestion.md). For the optional container stack,
`.devcontainer/docker/devcontainer.json` and `scripts/start_codespaces.sh` provide a
Docker-in-Docker environment. Create a Codespace from the branch containing these
changes. The setup builds and starts all services, sets the S3 signing origin to
the forwarded HTTPS portal host, and forwards 8095 (portal), 8096 (Airflow), and
9011 (MinIO administration). Ports are private by default.

To test from the separate public Pages frontend, its browser must be able to
reach the API endpoint without Codespaces' private-port authentication redirect.
Select an appropriately accessible test gateway, include
`https://tri-ctrl.github.io` in `UPLOAD_CORS_ORIGIN` (the Codespaces setup includes it), and set the Pages repository
variable to that gateway's HTTPS origin. Never make database, broker or Docker
ports public. Keep uploaded test data non-confidential until app-level access
control is configured.

Live Codespaces provisioning has not been performed in this session: the current
GitHub CLI authorization lacks the `codespace` scope and the API returns HTTP 403.
No existing cloud deployment secrets or backend URL variable were found in the
repository. Creating an actual runtime requires Codespaces access or a selected
server/cloud account. Local Docker and browser verification does not establish a
remote deployment.

Sources: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages),
[Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle),
[forwarded ports](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).
