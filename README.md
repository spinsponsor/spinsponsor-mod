# SpinSponsor Mod for Claude Code

SpinSponsor shows one labelled sponsored line while Claude works, in place of the usual spinner word (or a small card above the prompt when it fits), and shares the ad revenue with you 50/50.

- It never reads your prompts, code or files. Ads and links never enter Claude's context.
- Nothing happens until you sign in: no ads and no network calls.
- Pause any time with `/ads pause`, and resume with `/ads resume`.

Independent product, operated by SecAI Ltd. Not affiliated with Anthropic.

## First, check your Claude Code version

The Mod needs Claude Code **2.1.295 or newer**. In your terminal (not inside Claude Code), run:

```bash
claude --version
```

It prints something like `2.1.310 (Claude Code)`. If your number is lower than 2.1.295, update before you install, or the install fails (see [If the install fails](#if-the-install-fails)). How you update depends on how you installed Claude Code:

| You installed Claude Code with | Update with |
| --- | --- |
| The installer from claude.ai (most people) | `claude update` |
| Homebrew | `brew upgrade claude-code` (or `brew upgrade claude-code@latest` if that's your cask) |
| WinGet | `winget upgrade Anthropic.ClaudeCode` |
| npm | `npm install -g @anthropic-ai/claude-code@latest` |

Then run `claude --version` again to check. Homebrew and WinGet installs don't update themselves, so they are the ones most likely to be behind.

Also:

- Use Claude Code in a terminal (including the terminal inside VS Code or JetBrains), or the Claude Desktop app's **Code** tab. The Desktop app has its own copy of Claude Code: in a Code session, run `/status` and read the **Claude Code** row. If it is lower than 2.1.295, update the Desktop app.
- Ads don't appear in the VS Code extension's chat panel, cloud sessions, WSL sessions in the Desktop app, or `claude -p` runs.

## Install

In your terminal (not inside Claude Code), run:

```bash
claude plugin install spinsponsor --marketplace https://github.com/spinsponsor/spinsponsor-mod.git
```

Copy the command as it is: shortening the address to `owner/repo` can run into a GitHub SSH-key problem on some machines.

Or, at the Claude Code prompt, run the same thing as `/plugin install spinsponsor --marketplace https://github.com/spinsponsor/spinsponsor-mod.git` and choose **Install for you (user scope)**.

If it says some options are "not yet set", that's fine: leave them, you sign in instead. Start Claude Code (or run `/reload-plugins` in an open session) and sign in:

```text
/ads login
```

It shows a link and a code. Approve the code on your SpinSponsor dashboard, and this machine is linked. `/ads status` shows what the Mod is doing.

### Claude Desktop app

The Desktop app installs plugins only from marketplaces you've already added, so run the install command above in a terminal once. A plugin installed for you (user scope) also loads in the Desktop app's local Code sessions. Then run `/ads login` in a Desktop Code session.

## If the install fails

Both of these mean your Claude Code is too old. Run `claude --version`, update as shown [above](#first-check-your-claude-code-version), then restart Claude Code and try again.

- **`unknown option '--marketplace'`** when you run `claude plugin install`: the one-step install needs Claude Code 2.1.292 or newer.
- **`Failed to load hooks from .../hooks/hooks.json`** with `expected record, received undefined` and `"hooks"` in the details: this Claude Code is older than 2.1.287 and can't read Mods at all. After you update and restart, the Mod loads. If the error stays, run `claude plugin uninstall spinsponsor@spinsponsor` and then the install command again.

Still stuck? Email [contact@spinsponsor.com](mailto:contact@spinsponsor.com) with the output of `claude --version` and the full error message.

## Stay up to date

Claude Code doesn't auto-update plugins from marketplaces like this one unless you switch it on. Please do:

1. At the Claude Code prompt, run `/plugin`.
2. Go to the **Marketplaces** tab and select **spinsponsor**.
3. Select **Enable auto-update**.

When an update arrives you'll see `Plugin updated: spinsponsor · Run /reload-plugins to apply`. Restart Claude Code instead: after a reload (version 0.2.36 and later) ads stay off until you restart.

To update by hand instead, run this in your terminal, then restart Claude Code (a `/reload-plugins` keeps ads off until you do):

```bash
claude plugin update spinsponsor@spinsponsor
```

## Commands

| Command | What it does |
| --- | --- |
| `/ads status` | What the Mod is doing, and why if ads are off |
| `/ads pause` / `/ads resume` | Turn ads off and on |
| `/ads open` | The link of the last ad shown |
| `/ads login` / `/ads logout` | Link or unlink this machine |

## Uninstall

```bash
claude plugin uninstall spinsponsor@spinsponsor
claude plugin marketplace remove spinsponsor
```

Revoke the machine on your SpinSponsor dashboard too if you won't use it again.

## For team admins

You can register this marketplace on your team's machines with managed settings (or a repository's `.claude/settings.json`):

```json
{
  "extraKnownMarketplaces": {
    "spinsponsor": {
      "source": { "source": "git", "url": "https://github.com/spinsponsor/spinsponsor-mod.git" },
      "autoUpdate": true
    }
  }
}
```

- Ads stay opt-in for each person: they install the Mod and sign in themselves. Without a sign-in it shows nothing and makes no network calls.
- To block it, set `"spinsponsor@spinsponsor": false` under `enabledPlugins` in managed settings. `allowManagedModsOnly` and marketplace allowlists also stop it, and SpinSponsor never works around them.
- If you use `strictKnownMarketplaces`, allow the same source as above: `{ "source": "git", "url": "https://github.com/spinsponsor/spinsponsor-mod.git" }`.

See Claude Code's [organization plugin settings](https://code.claude.com/docs/en/plugins/org).

## Privacy and support

- Privacy notice: <https://spinsponsor.com/privacy.html>
- Support: [contact@spinsponsor.com](mailto:contact@spinsponsor.com)
- Changes in each version: [CHANGELOG.md](CHANGELOG.md)

## Check a release

Each release has a signed git tag (`v0.2.35` and so on) and, on its GitHub release page, a ZIP of the plugin, a `SHA256SUMS` list and that list's signature `SHA256SUMS.sig`. The signing key is in [`allowed_signers`](allowed_signers); its fingerprint is also published on spinsponsor.com. To check a download, put the files in one folder and run:

```bash
shasum -a 256 -c SHA256SUMS
ssh-keygen -Y verify -f allowed_signers -I contact@spinsponsor.com -n file -s SHA256SUMS.sig < SHA256SUMS
```

To check a tag in a clone of this repository: `git -c gpg.ssh.allowedSignersFile=allowed_signers tag -v v0.2.35`.

Claude Code itself doesn't check these signatures when it installs; they let you check by hand.

## Licence

Copyright 2026 SecAI Ltd. The Mod is licensed under the Apache License, Version 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trade marks

"SpinSponsor" and its logo are trade marks of SecAI Ltd. The licence gives no permission to use them, except as reasonably needed to say where the code came from (section 6 of the licence). If you distribute a modified version, give it a different name and don't present it as SpinSponsor or as connected with or approved by us; saying it is based on SpinSponsor is fine.
