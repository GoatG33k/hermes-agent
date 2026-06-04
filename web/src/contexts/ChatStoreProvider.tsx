import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChatStore } from "@/lib/chatStore";
import type { ChatStoreDeps, ChatStorePersistence } from "@/lib/chatStore";
import { createGatewayChatDeps } from "@/lib/gatewayChatDeps";
import { ChatStoreContext } from "@/contexts/chat-store-context";

interface ChatStoreProviderProps {
  children: ReactNode;
  /** Backend wiring used to construct the store. Read **once** at mount;
   *  later changes are intentionally ignored (the store is a stable
   *  singleton). Tests inject fakes here. Defaults to the real gateway +
   *  REST deps. */
  initialDeps?: ChatStoreDeps;
  /** Persistence used to construct the store. Read **once** at mount; later
   *  changes are ignored. Tests inject an in-memory store. */
  initialPersistence?: ChatStorePersistence;
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
 *
 * Note: `initialDeps` / `initialPersistence` are construction-time only. The
 * store is deliberately a stable singleton for the app's lifetime, so swapping
 * these props after mount has no effect (the `initial` prefix signals this).
 */
export function ChatStoreProvider({
  children,
  initialDeps,
  initialPersistence,
  autoHydrate = true,
}: ChatStoreProviderProps) {
  // One store for the app's lifetime. `useMemo` with an empty dep array keeps
  // the same instance across re-renders; the initial deps/persistence are
  // captured once here by design (see the prop docs above).
  const store = useMemo(
    () => new ChatStore(initialDeps ?? createGatewayChatDeps(), initialPersistence),
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
