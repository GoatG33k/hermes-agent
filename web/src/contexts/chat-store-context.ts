import { createContext } from "react";
import type { ChatStore } from "@/lib/chatStore";

/**
 * Carries the singleton `ChatStore` instance down the tree. The store is a
 * plain observable (not React state) so the context value is referentially
 * stable for the whole app lifetime — consumers subscribe via
 * `useSyncExternalStore` in `useChatStore`, not via context re-renders.
 */
export const ChatStoreContext = createContext<ChatStore | null>(null);
