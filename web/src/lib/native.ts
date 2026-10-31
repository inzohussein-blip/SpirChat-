// Bridge to the Android shell (android/), present only when running inside the app.

export interface NativeBridge {
  sendToPeer(endpointId: string, data: string): void;
  startMesh(): void;
  stopMesh(): void;
  isMeshRunning(): boolean;
  /** IPv4 address of the current Wi-Fi gateway, usually the hub; '' if none. */
  gatewayIp(): string;
  shareApp(): void;
  openUrl(url: string): void;
}

/** Callbacks the Android shell invokes via evaluateJavascript. */
export interface PeerCallbacks {
  onConnected(endpointId: string): void;
  onDisconnected(endpointId: string): void;
  onMessage(endpointId: string, data: string): void;
  onMeshState(running: boolean): void;
  onNetworkChanged(): void;
}

declare global {
  interface Window {
    SpirChatNative?: NativeBridge;
    spirchatPeer?: PeerCallbacks;
  }
}

export const native: NativeBridge | undefined = window.SpirChatNative;
