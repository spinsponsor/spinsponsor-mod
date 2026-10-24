// The values this Mod keeps in the session ($.state), which survive a reload of its code
declare module 'claude-code' {
  interface PluginState {
    spinsponsor: {
      // Dialogs still open that hide the ad: marker -> the agent it belongs to ('main' for the main loop)
      dialogs: Record<string, string>
      // Written once, by the first load of a Claude Code session, before ads are enabled. A load that finds it is a reload: ads stay off
      // until Claude Code restarts (which starts with empty state), because a reload can't be told what dialogs are open.
      started: boolean
    }
  }
}
