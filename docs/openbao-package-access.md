# Package access

Bob Runtime reads the private @teampitch/dev-tools package from GitHub
Packages.

The source record is the OpenBao KV v2 field
ops/apps/prod/bob/registry/ghcr/TEAMPITCH_PACKAGES_TOKEN. The
bob-runtime-ci-packages policy can read only that record. Its JWT role binds
to the arek-e/bob repository, the CI workflow, a main-branch push, and the
GitHub Actions audience.

The CI workflow tries the short-lived OpenBao OIDC path on a trusted main push.
Pull requests and runners without Tailnet access use the synchronized
TEAMPITCH_PACKAGES_TOKEN Actions secret. This fallback is required because
the shared ARC runner has public egress only.

Configure the role from a host that can reach OpenBao:

    export BAO_ADDR=https://vault.lamb-bicolor.ts.net
    export BAO_TOKEN=...
    ./scripts/configure-openbao-package-access.sh
    unset BAO_TOKEN
    ./scripts/sync-openbao-package-token.sh

Never print or commit the token.
