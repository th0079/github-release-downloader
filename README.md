# Release Downloader

Release Downloader is an unofficial Electron desktop app for browsing public GitHub releases and downloading selected assets.

This app is not affiliated with, endorsed by, or sponsored by GitHub. GitHub is a trademark of GitHub, Inc.

## Features

- Search public repositories by name or enter `owner/repo`
- Browse release lists and asset metadata
- Filter assets by platform
- Download selected files to a local folder
- Show SHA256 for completed downloads
- Optionally use a GitHub PAT for higher API rate limits

## Security and Safety

- Renderer access is limited through preload IPC APIs
- Electron `contextIsolation` is enabled
- Electron `sandbox` is enabled
- Download redirects are restricted to approved HTTPS GitHub/GitHubusercontent hosts
- GitHub PAT storage is allowed only when OS secure storage is available

## Legal Notice

- Downloaded files are provided by third-party publishers, not by this app
- You are responsible for checking the publisher, license terms, export restrictions, and local laws before downloading or running files
- Verify the displayed SHA256 or the publisher's official checksum/signature before execution

See [NOTICE.md](./NOTICE.md) and [PRIVACY.md](./PRIVACY.md) for distribution guidance.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Build

```bash
npm run build
```

## Version

- `0.1.4`

## License

MIT. See [LICENSE](./LICENSE).
