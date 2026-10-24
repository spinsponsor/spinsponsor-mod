# Changelog

Each release of the SpinSponsor Mod. A new version always has a higher number, including a rollback to older code.

## 0.2.37

- Ads now pause for as long as a background command that Claude Code tracks is running (for example a dev server Claude started, or a Monitor), instead of for a fixed 2 minutes. They come back once Claude Code reports that the command has ended. Claude Code can show a network prompt over the ad without telling the Mod; this makes it much less likely that a view is counted under one while such a command runs, but it cannot rule it out: a command that detaches itself from Claude Code is not tracked (see section 5.3 of the developer terms).
- If Claude Code does not report a background command, the 2-minute pause applies as before.
- `/ads status` also shows how many background commands are being tracked.

## 0.2.36

- Ads pause while Claude runs a command, and for 2 minutes after Claude starts a command in the background. Claude Code can show a network prompt over the ad without telling the Mod; this makes it much less likely that a view is counted under one, but it cannot rule it out (see section 5.3 of the developer terms).
- After the Mod is reloaded (for example `/reload-plugins` after an update), ads stay off until you restart Claude Code. Restart instead of reloading.
- `/ads status` shows how many commands are running and how long commands have held ads back.
- Developer terms 5.3 says so (new version 2026-10-24): accept it on your dashboard when asked.

## 0.2.35

- First public release.
