// The values this Mod keeps in the session ($.state), which survive a reload of its code
declare module 'claude-code' {
  interface PluginState {
    spinsponsor: {
      // Dialogs still open that hide the ad: marker -> the agent it belongs to ('main' for the main loop)
      dialogs: Record<string, string>
    }
  }
}
