# SpinSponsor Mod for Claude Code

SpinSponsor shows one labelled sponsored line while Claude works, in place of the usual spinner word (or a small card above the prompt when it fits), and shares the ad revenue with you 50/50.

- It never reads your prompts, code or files. Ads and links never enter Claude's context.
- Nothing happens until you sign in: no ads and no network calls.
- Pause any time with `/ads pause`, and resume with `/ads resume`.

Independent product, operated by SecAI Ltd. Not affiliated with Anthropic.

## Install

SpinSponsor is preparing for launch, so install steps aren't published yet. Join the waitlist at <https://spinsponsor.com> to hear when access opens.

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

- Ads stay opt-in for each person. Without a sign-in the Mod shows nothing and makes no network calls.
- To block it, set `"spinsponsor@spinsponsor": false` under `enabledPlugins` in managed settings. `allowManagedModsOnly` and marketplace allowlists also stop it, and SpinSponsor never works around them.

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
