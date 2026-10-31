// Bridge to the Android shell (android/app MainActivity.Bridge), present only inside the app.
// In the app, the native engine syncs (nearby phones, local hub, internet hubs) even with the
// screen off; the web UI only reads from it and publishes to it.

export interface NativeBridge {
  /** JSON {items: [{seq, env}], last, more} of envelopes stored after `since`. */
  storeSince(since: string): string;
  /** '' when accepted, otherwise the rejection reason. */
  publish(json: string): string;
  /** JSON array: which of the given IDs a hub has confirmed. */
  delivered(idsJson: string): string;
  /** JSON {hubs: [{url, internet, state, name}], peers, mesh, alertKeys}. */
  status(): string;
  settings(): string;
  updateSettings(json: string): string;
  setIdentity(tag: string, id: string): void;
  startMesh(): void;
  stopMesh(): void;
  isMeshRunning(): boolean;
  shareApp(): void;
  exportBundle(): void;
  openUrl(url: string): void;
  wipe(): void;
}

/** Called by the shell (evaluateJavascript) when the engine's state changed. */
export interface NativeEvents {
  onChanged(): void;
}

declare global {
  interface Window {
    SpirChatNative?: NativeBridge;
    spirchatEvents?: NativeEvents;
  }
}

export const native: NativeBridge | undefined = window.SpirChatNative;
