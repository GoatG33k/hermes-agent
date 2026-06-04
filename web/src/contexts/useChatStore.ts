import { useContext, useSyncExternalStore } from "react";
import { ChatStoreContext } from "@/contexts/chat-store-context";
import type { ChatStore, ChatStoreState } from "@/lib/chatStore";

/**
 * Subscribe a component to the chat store. Returns the live, immutable state
 * snapshot plus the store instance for issuing actions
 * (`createSession`, `selectSession`, `deleteSession`, `openWidget`, …).
 *
 * Re-renders only when the snapshot's identity changes, which the store
 * guarantees only happens on real state transitions.
 *
 * @example
 *   const { state, store } = useChatStore();
 *   return (
 *     <button onClick={() => store.createSession()}>
 *       {state.sessions.length} chats
 *     </button>
 *   );
 */
export function useChatStore(): {
  state: ChatStoreState;
  store: ChatStore;
} {
  const store = useContext(ChatStoreContext);
  if (!store) {
    throw new Error("useChatStore must be used within a ChatStoreProvider");
  }
  // The dashboard is a client-only SPA (createRoot, no SSR), but passing
  // getServerSnapshot future-proofs against hydration mismatches if it ever
  // gains server rendering — the store's snapshot is the same on both sides.
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { state, store };
}
