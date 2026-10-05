# Obsttorte

[日本語](./README.ja.md)

Obsttorte is software that syncs an Obsidian vault across multiple devices. It consists of a server that runs on Cloudflare Workers, D1, and R2, an Obsidian plugin, and a CLI.

You self-host a server in your own Cloudflare account for each vault. It syncs the whole vault: not only your notes, but also the plugins and settings in the config folder. It also provides per-file merges, a UI for resolving conflicts, and a revision history you can restore from.

## Requirements

- A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/)
  - The CPU time and D1 storage on the Workers Free plan are not enough.
  - It uses D1 for the database and R2 for storage. At the scale of a single user, it is designed to stay within the allowance included in the Paid plan and the R2 free tier.
- Cloudflare Zero Trust (Free plan)
  - It is used for access control.
- Node.js 22 or later for running the CLI
- Obsidian 1.13.0 or later

## Installation

### Server

```sh
npx obsttorte@latest setup
```

The CLI walks you through creating a Worker, a D1 database, and an R2 bucket, then deploys them. It then shows the steps for setting up Cloudflare Access. Follow them in the Cloudflare dashboard, and enter the AUD tag, the Client ID, and the expiration date of the service token. The Client Secret is shown only when you create the service token, so keep a copy of it.

Finally, the CLI registers your first device and prints the values to enter in the plugin. The device token is shown only at this point. Your answers are saved to `~/.config/obsttorte/<worker-name>.json`. Secrets such as tokens are never saved.

Set up a server for each vault. To create several servers in a single Cloudflare account, give each one its own Worker name with the `--name` option.

```sh
npx obsttorte@latest setup --name obsttorte-work
```

### Plugin

(The plugin is being prepared for listing in Obsidian’s Community plugins. We will announce it once it is available.)

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

This deploys the bundled server and applies any pending database migrations. It does not touch your devices, your Access settings, or your vault data. If you run several servers, pick one with `--name`, or update all of them with `--all`.

Update the plugin on each device. The server and the plugin work together when their version numbers match. If a device runs a plugin too old for the new server, `update` stops and shows that device.

## Caveats

- Do not use it on a vault that is already synced with Obsidian Sync, iCloud Drive, Dropbox, or similar services.
- On the iOS and Android mobile apps, OS restrictions mean that it syncs only while Obsidian is on screen.
- Files larger than 100 MB cannot be synced.
- Files are stored on the server without encryption. If your Cloudflare account credentials leak, the contents of your files may be read.
- If you enable JavaScript in a plugin that runs note content as code, such as dataviewjs in Dataview or Templater, JavaScript in notes that arrive from another device may run.
- The developer is not responsible for any data loss caused by bugs in this software.

## Privacy policy

The plugin communicates only with the server you created, and the CLI communicates only with that server and the Cloudflare API. Nothing is sent to the developer. The data sent to the server is the files in your vault, their hashes, and your device credentials.

## License

Licensed under the MIT License, Copyright © 2026 [@shikakun](https://shikakun.com).

See [LICENSE](./LICENSE) for more information.
