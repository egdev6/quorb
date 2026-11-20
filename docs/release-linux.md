# Attach Linux installers to an existing release

Run **Actions → Attach Linux installers to existing release** manually from
`main`. Supply the stable `version` without `v` (for example `0.9.0`) and the
full 40-character lowercase `source_sha` of that release's tag. The SHA must
be an ancestor of `origin/main`; the release and its matching tag must already
exist, including for a draft. Manifest versions and the Tauri configuration
must match. No tag or release is created or changed.

The Ubuntu 22.04 build verifies both bundles in a clean container and attaches
only `Quorb_<version>_amd64.deb`, `Quorb_<version>_amd64.AppImage`, and a
`.sha256` file for each. It refuses to overwrite any of these names and checks
again immediately before uploading. On an upload failure it rolls back only
IDs confirmed as uploaded by this run. If an upload response is ambiguous or
rollback fails, inspect the release assets and clean up any reported leftovers
manually before retrying.

Linux updates are manual: download and install a newer release yourself; there
is no Linux entry in `latest.json`. The `.deb` is recommended. The AppImage
requires FUSE (`libfuse2`) and may fail on some desktops even with FUSE
installed.
