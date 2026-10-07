<img src="https://raw.githubusercontent.com/shikakun/obsttorte/main/public/icon-1024.png" alt="" width="192" height="192">

# Obsttorte

[日本語](./README.ja.md)

Obsttorte is software that syncs an Obsidian vault across multiple devices. It consists of a server that runs on Cloudflare Workers, D1, and R2, an Obsidian plugin, and a CLI.

For each vault, you self-host a server in your own Cloudflare account. It syncs your entire vault, including the plugins and settings in the config folder as well as your notes. It also offers per-file merging, a UI for resolving conflicts, and a revision history you can restore from.

## Requirements

- A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/)
  - The Workers Free plan does not provide enough CPU time or D1 storage.
  - Obsttorte uses R2 for storage and Cloudflare Zero Trust for access control. For personal use, it is designed to stay within their free tiers.
- Node.js 22 or later for running the CLI
- Obsidian 1.13.0 or later

## Installation

### Server

```sh
npx obsttorte@latest setup
```

The CLI walks you through creating a Worker, a D1 database, and an R2 bucket, then deploys them. It then shows the steps for setting up Cloudflare Access. Follow them in the Cloudflare dashboard, and enter the AUD tag, the Client ID, and the service token’s expiration date. Your answers are saved to `~/.config/obsttorte/<worker-name>.json`, excluding secrets such as tokens.

You need a server for each vault. To create several servers in a single Cloudflare account, give each one its own Worker name with the `--name` option.

```sh
npx obsttorte@latest setup --name obsttorte-work
```

### Plugin

Install [Torte](https://community.obsidian.md/plugins/obsttorte) from Obsidian’s Community plugins.

1. In Obsidian, open **Settings → Community plugins**, select **Browse**, and search for “Torte”.
2. Install Torte and enable it.
3. In the Torte settings, enter the server URL, Access Client ID, Access Client Secret, and device token.

### Device tokens

Each device gets its own device token. If you lose a device, you can stop it from syncing by revoking its device token.

```sh
npx obsttorte@latest device add --device-name iPhone
npx obsttorte@latest device list
npx obsttorte@latest device revoke <ID>
```

## Updating

```sh
npx obsttorte@latest update
```

This deploys the latest code to your server and applies database migrations. If you run several servers, specify one with `--name`, or update all of them with `--all`. Update the Obsidian plugin from within Obsidian on each device where it is installed.

## Caveats

- Do not use it on a vault that is already synced with Obsidian Sync, iCloud Drive, Dropbox, or similar services.
- On the iOS and Android mobile apps, due to OS restrictions, syncing happens only while Obsidian is in the foreground.
- Files larger than 100 MB cannot be synced.
- Files are stored on the server without encryption. If your Cloudflare account credentials leak, the contents of your files could be exposed.
- If you enable JavaScript in a plugin that runs note content as code, such as dataviewjs in Dataview or Templater, JavaScript in notes synced from other devices may run.
- The developer is not responsible for any data loss caused by bugs in this software.

## Privacy policy

The plugin communicates only with the server you created, and the CLI communicates only with that server and the Cloudflare API. Nothing is sent to the developer. The data sent to the server is the files in your vault, their hashes, and your device credentials.

## License

Obsttorte is distributed under the MIT License. Copyright © 2026 [@shikakun](https://shikakun.com).

See [LICENSE](./LICENSE) for more information.
