// Control UI module lets the shell reset the chat view's module state without importing it.
//
// The chat view is a lazy page: importing it just to reach its reset would put the whole chat
// renderer (and the markdown runtime behind it) back into the first load. Loading the view through
// here records its reset; a view that never loaded has nothing to reset.

let resetChatView: (() => void) | null = null;

export function loadChatView() {
  return import("../views/chat.ts").then((mod) => {
    resetChatView = mod.resetChatViewState;
    return mod;
  });
}

export function resetChatViewStateIfLoaded(): void {
  resetChatView?.();
}
