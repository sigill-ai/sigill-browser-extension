# Chrome Web Store publishing

Publishing a GitHub release runs `.github/workflows/release.yml`:

1. **build** — `tools/pack.sh` (tests first); the zip is attached to the release.
2. **publish** — uploads the same zip to the Chrome Web Store (API v2) and submits it
   for review. Google's review still decides when the version goes live.

The publish job is keyless. GitHub's OIDC token is exchanged through Google Workload
Identity Federation for a 10-minute access token of a dedicated service account, scoped
to `https://www.googleapis.com/auth/chromewebstore`. No Google key or refresh token is
stored in GitHub. The job is skipped while `GCP_WIF_PROVIDER` is unset.

## Releasing

Bump `version` in `manifest.json`, merge, then publish a GitHub release. The store
rejects an upload whose version is not higher than the published one.

## Setup (done 2026-10-11)

- **Google Cloud** project `invertible-vent-511320-b9`:
  - APIs enabled: Chrome Web Store, IAM Credentials, STS.
  - Service account `cws-publisher@invertible-vent-511320-b9.iam.gserviceaccount.com`,
    no project roles, no keys.
  - Workload identity pool `github`, OIDC provider `sigill-ai`
    (issuer `https://token.actions.githubusercontent.com`), attribute condition
    `assertion.repository == 'sigill-ai/sigill-browser-extension' && assertion.environment == 'chrome-web-store'`.
  - `roles/iam.workloadIdentityUser` on the service account for
    `principalSet://…/workloadIdentityPools/github/attribute.repository/sigill-ai/sigill-browser-extension`.
- **Chrome Web Store Developer Dashboard**: the service account is registered on the
  publisher that owns the item (Publisher → Settings → Service account). Only one
  service account per publisher.
- **GitHub**: environment `chrome-web-store`, and repository variables (not secrets —
  none of them is a credential): `GCP_WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT`,
  `CWS_PUBLISHER_ID`.

To revoke publishing access, remove the service account in the dashboard or delete the
workload identity provider.
