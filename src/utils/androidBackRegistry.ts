/**
 * LIFO registry of "exit layers" for the Android system back button.
 *
 * Overlays that are not plain UIStore modals (survey mode, custom dialogs,
 * fullscreen views) register a close handler while they are open. The global
 * Android back handler pops the topmost layer first and only falls back to
 * its hardcoded modal list / synthetic Escape when the registry is empty.
 */

export type ExitLayerHandler = () => void;

const layers: ExitLayerHandler[] = [];

export function pushExitLayer(handler: ExitLayerHandler): void {
  layers.push(handler);
}

export function removeExitLayer(handler: ExitLayerHandler): void {
  const index = layers.lastIndexOf(handler);
  if (index >= 0) layers.splice(index, 1);
}

/** Invokes the topmost exit layer. Returns false when the registry is empty. */
export function popExitLayer(): boolean {
  const handler = layers.pop();
  if (!handler) return false;
  handler();
  return true;
}
