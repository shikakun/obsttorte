<img src="https://raw.githubusercontent.com/shikakun/obsttorte/main/public/icon-1024.png" alt="" width="192" height="192">

# Obsttorte

[English](./README.md)

Obsttorteは、Obsidianのvaultを複数のデバイスで同期するソフトウェアです。Cloudflare Workers、D1、R2で動作するサーバーと、Obsidianのプラグイン、CLIで構成されています。

vaultごとに、ユーザーが自身のCloudflareアカウントにサーバーをセルフホストします。ノートだけでなく、設定フォルダにあるプラグインや設定も含めてvault全体を同期するほか、ファイル単位のマージ、競合した内容を解決するUI、変更履歴を保存して復元する機能を備えています。

## 利用に必要なもの

- [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/)を契約したCloudflareアカウント
  - Workers Free planではCPUを利用できる時間とD1の容量が足りないため、Paid planでご利用ください。
  - ストレージにはR2、アクセス制限にはCloudflare Zero Trustを使用しますが、個人で利用する規模であれば無料枠に収まるように設計しています。
- CLIの実行に必要なNode.js 22以降
- Obsidian 1.13.0以降

## インストール

### サーバー

```sh
npx obsttorte@latest setup
```

CLIを実行すると、対話形式でWorker、D1のデータベース、R2のバケットを作成し、デプロイします。Cloudflare Accessの設定手順が表示されるので、Cloudflareのダッシュボードで設定し、AUDタグ、Client ID、サービストークンの有効期限を入力します。入力した内容は`~/.config/obsttorte/<Worker名>.json`に保存しますが、トークンなどの秘密情報は含めません。

サーバーはvaultごとに必要です。`--name`オプションでWorkerの名前を変えると、ひとつのCloudflareアカウントで複数のサーバーを作成できます。

```sh
npx obsttorte@latest setup --name obsttorte-work
```

### プラグイン

Obsidianのコミュニティプラグインから「[Torte](https://community.obsidian.md/plugins/obsttorte)」をインストールしてください。

1. Obsidianの「設定」→「コミュニティプラグイン」で「閲覧」を選び、「Torte」を検索します。
2. Torteをインストールして、有効化します。
3. Torteの設定画面で、サーバーURL、Access Client ID、Access Client Secret、デバイストークンを入力します。

### デバイストークン

デバイスごとにデバイストークンを発行します。この仕組みにより、もしデバイスを紛失しても、デバイストークンを失効させることで同期を停止できます。

```sh
npx obsttorte@latest device add --device-name iPhone
npx obsttorte@latest device list
npx obsttorte@latest device revoke <ID>
```

## アップデート

```sh
npx obsttorte@latest update
```

コマンドを実行すると、サーバーに最新のコードをデプロイし、データベースのマイグレーションを適用します。複数のサーバーを運用している場合は、`--name`で対象を指定するか、`--all`を指定するとすべてのサーバーをアップデートできます。Obsidianプラグインは、インストールしたデバイスごとにObsidian上でアップデートしてください。

## 注意事項

- すでにObsidian Sync、iCloud Drive、Dropboxなどで同期しているvaultでは、Obsttorteを併用しないでください。
- iOS、Androidのモバイルアプリでは、OSの制限によりObsidianを画面に表示していないと同期が行われません。
- 100MBを超えるファイルは同期できません。
- サーバーに保存するファイルは暗号化しません。Cloudflareのアカウント情報が漏洩した場合、ファイルの内容を読まれる可能性があります。
- DataviewのdataviewjsやTemplaterのように、ノートの内容をコードとして実行するプラグインでJavaScriptの実行を有効にしている場合、ほかのデバイスから届いたノートのJavaScriptが実行される可能性があります。
- このソフトウェアの不具合が原因でデータが消失した場合も、開発者は責任を負いません。

## プライバシーポリシー

プラグインはユーザーが作成したサーバーとのみ、CLIはそれに加えてCloudflare APIとのみ通信し、開発者には何も送信しません。サーバーに送信するデータは、vaultのファイルとハッシュ、デバイスの認証情報です。

## ライセンス

ObsttorteはMITライセンスで配布しています。Copyright © 2026 [@shikakun](https://shikakun.com).

詳細は、[LICENSE](./LICENSE)をご覧ください。
