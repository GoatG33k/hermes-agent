import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChatStore } from "@/lib/chatStore";
import type { ChatStoreDeps, ChatStorePersistence } from "@/lib/chatStore";
import { createGatewayChatDeps } from "@/lib/gatewayChatDeps";
import { ChatStoreContext } from "@/contexts/chat-store-context";

interface ChatStoreProviderProps {
  children: ReactNode;
  /** Override the backend wiring (tests inject fakes). Defaults to the real
   *  gateway + REST deps. */
  deps?: ChatStoreDeps;
  /** Override persistence (tests inject an in-memory store). */
  persistence?: ChatStorePersistence;
  /** Set false to skip the initial server hydration (tests / storybook). */
  autoHydrate?: boolean;
}

/**
 * Mounts the singleton `ChatStore` above the router so chat state — the active
 * session, the session list, and the widget's open/minimized flags — is shared
 * across every page and survives navigation. The store's localStorage
 * persistence is what carries it across full page refreshes.
 *
 * Mount this inside `BrowserRouter` (alongside the other app providers) so the
 * pinned chat widget and any page can read the same store.
 */
export function ChatStoreProvider({
  children,
  deps,
  persistence,
  autoHydrate = true,
}: ChatStoreProviderProps) {
  // One store for the app's lifetime. `useMemo` with a stable dep keeps the
  // same instance across re-renders; deps/persistence are only read once.
  const store = useMemo(
    () => new ChatStore(deps ?? createGatewayChatDeps(), persistence),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!autoHydrate || hydratedRef.current) return;
    hydratedRef.current = true;
    void store.hydrate();
  }, [store, autoHydrate]);

  return (
    <ChatStoreContext.Provider value={store}>
      {children}
    </ChatStoreContext.Provider>
  );
}
