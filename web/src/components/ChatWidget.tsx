/**
 * ChatWidget — a docked, minimizable chat widget for the web dashboard.
 *
 * Two visible states persisted via ChatStore:
 *   - minimised (FAB pill in bottom-right)
 *   - expanded (380×500px panel, chat view by default)
 *
 * Mount this component outside <Routes> so it survives page navigation.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/contexts/useChatStore";
import type { ChatMessage, ChatSession } from "@/lib/chatStore";
import { Markdown } from "@/components/Markdown";
import {
  MessageSquare,
  Minus,
  X,
  Send,
  Plus,
  Users,
  ChevronDown,
  Check,
  Loader2,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ProfileInfo } from "@/lib/api";

// ── helpers ─────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "user": return "You";
    case "assistant": return "Assistant";
    case "system": return "System";
    case "tool": return "Tool";
    default: return role;
  }
}

// ── Profile Picker ───────────────────────────────────────────────────

function WidgetProfilePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getProfiles()
      .then((res) => { if (!cancelled && res.profiles) setProfiles(res.profiles); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const label = value ?? "default";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-text-secondary hover:text-text-primary hover:bg-midground/10 transition-colors"
        title="Select profile"
      >
        <Users className="h-3 w-3 shrink-0" />
        <span className="max-w-20 truncate">{label}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0" />
      </button>

      {open && (
        <Fragment>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-[200] mt-1 w-48 rounded-lg border border-border p-1 shadow-xl"
            style={{ background: "var(--background-base)" }}
          >
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
              Profile
            </div>
            {loading && (
              <div className="px-2 py-3 text-xs text-text-secondary">loading…</div>
            )}
            {!loading && profiles.length === 0 && (
              <div className="px-2 py-3 text-xs text-text-secondary">no profiles</div>
            )}
            {profiles.map((p) => {
              const active = p.name === value || (!value && p.is_default);
              return (
                <button
                  key={p.name}
                  onClick={() => { onChange(p.is_default ? null : p.name); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active ? "bg-accent/10 text-accent" : "text-text hover:bg-midground/5",
                  )}
                >
                  <Check className={cn("h-3 w-3 shrink-0", active ? "opacity-100" : "opacity-0")} />
                  <div className="min-w-0 flex-1 truncate">{p.name}</div>
                  {p.is_default && (
                    <span className="shrink-0 rounded bg-midground/10 px-1 py-0.5 text-[9px] text-text-tertiary">
                      default
                    </span>
                  )}
                </button>
              );
            })}
            <div className="mt-1 border-t border-border/50" />
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                value === null ? "text-accent" : "text-text-secondary hover:text-text",
              )}
            >
              <Check className={cn("h-3 w-3 shrink-0", value === null ? "opacity-100" : "opacity-0")} />
              System default
            </button>
          </div>
        </Fragment>
      )}
    </div>
  );
}

// ── Message bubble ──────────────────────────────────────────────────

const ThinkingBubble = memo(function ThinkingBubble({ text }: { text: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 items-start">
      <span className="text-[10px] text-text-tertiary px-1 flex items-center gap-1">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Thinking…
      </span>
      <div className="rounded-lg rounded-bl-sm px-2.5 py-2 max-w-[85%] bg-surface/60 border border-border/30">
        {text ? (
          <p className="text-[11px] leading-relaxed text-text-tertiary italic line-clamp-6 whitespace-pre-wrap">
            {text}
          </p>
        ) : (
          <div className="flex gap-1 items-center py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary/60 animate-bounce [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary/60 animate-bounce [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary/60 animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </div>
    </div>
  );
});

const ChatBubble = memo(function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  // Thinking state: assistant message with no content yet
  if (!isUser && message.thinking !== undefined && !message.content) {
    return <ThinkingBubble text={message.thinking ?? null} />;
  }

  return (
    <div className={cn("flex flex-col gap-0.5", isUser ? "items-end" : "items-start")}>
      <span className="text-[10px] text-text-tertiary px-1">
        {roleLabel(message.role)}
        {message.timestamp ? ` · ${formatTime(message.timestamp)}` : ""}
      </span>
      <div
        className={cn(
          "w-full rounded-lg px-2.5 py-1.5",
          isUser
            ? "bg-accent/20 text-text-primary rounded-br-sm text-xs leading-relaxed max-w-[85%]"
            : "bg-surface text-text-primary rounded-bl-sm w-full",
        )}
      >
        {message.content ? (
          isUser ? (
            <span className="whitespace-pre-wrap">{message.content}</span>
          ) : (
            <div className="[&>div]:text-xs [&>div]:leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-[11px]">
              <Markdown content={message.content} />
            </div>
          )
        ) : (
          <span className="italic text-text-tertiary text-xs">(empty)</span>
        )}
      </div>
    </div>
  );
});

// ── Session list item ───────────────────────────────────────────────

function SessionListItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors cursor-pointer",
        active
          ? "bg-accent/10 text-accent"
          : "text-text-secondary hover:bg-midground/10 hover:text-text-primary",
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      <span className="min-w-0 flex-1 truncate">
        {session.title || session.preview || session.id.slice(0, 8)}
      </span>
      <span className="shrink-0 text-[10px] text-text-tertiary">{session.messageCount}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="shrink-0 rounded p-0.5 text-text-tertiary hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Main Widget ─────────────────────────────────────────────────────

export function ChatWidget() {
  const { state, store } = useChatStore();
  const { widgetOpen, minimized, sessions, activeSessionId, messages, loading, hydrated, widgetWidth, widgetHeight } = state;

  // Only show user/assistant messages; skip tool results and system prompts.
  // Keep in-progress assistant messages (content: null, thinking defined) so
  // the thinking bubble renders while the agent is working.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          (m.content || m.thinking !== undefined),
      ),
    [messages],
  );
  const [composer, setComposer] = useState("");
  const [profile, setProfile] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: loading ? "auto" : "smooth",
      });
      scrollRafRef.current = null;
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [messages, loading]);

  useEffect(() => {
    if (widgetOpen && !minimized) {
      composerRef.current?.focus();
    }
  }, [widgetOpen, minimized]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      resizeStartRef.current = {
        x: clientX,
        y: clientY,
        w: widgetWidth,
        h: widgetHeight,
      };
    },
    [widgetWidth, widgetHeight],
  );

  useEffect(() => {
    if (!resizeStartRef.current) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!resizeStartRef.current) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

      // Resize increases width when dragging right, increases height when dragging down
      // Resize increases width when dragging right (deltaX), increases height when dragging UP (-deltaY)
      const deltaX = resizeStartRef.current.x - clientX;
      const deltaY = resizeStartRef.current.y - clientY;

      const newWidth = resizeStartRef.current.w + deltaX;
      const newHeight = resizeStartRef.current.h + deltaY;

      store.setWidgetSize(newWidth, newHeight);
    };

    const handleEnd = () => {
      resizeStartRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("touchmove", handleMove);
      document.removeEventListener("mouseup", handleEnd);
      document.removeEventListener("touchend", handleEnd);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("touchmove", handleMove);
    document.addEventListener("mouseup", handleEnd);
    document.addEventListener("touchend", handleEnd);

    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("touchmove", handleMove);
      document.removeEventListener("mouseup", handleEnd);
      document.removeEventListener("touchend", handleEnd);
    };
  }, [store]);

  const handleComposerChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setComposer(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const handleSend = useCallback(async () => {
    const text = composer.trim();
    if (!text) return;

    let sid = activeSessionId;
    if (!sid) {
      sid = await store.createSession({ profile });
      if (!sid) return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    };
    store.appendMessage(userMsg);
    setComposer("");
    if (composerRef.current) {
      composerRef.current.style.height = "auto";
    }

    await store.sendMessage(sid, text);
  }, [composer, activeSessionId, store, profile]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  // ── RENDER ───────────────────────────────────────────────────────

  // ── Minimized FAB ────────────────────────────────────────────────
  if (!widgetOpen || minimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <Button
          onClick={() => store.openWidget()}
          className="flex h-12 w-12 items-center justify-center rounded-full shadow-lg bg-accent text-white hover:bg-accent/90 transition-all"
          aria-label="Open chat"
          title="Open chat"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
      </div>
    );
  }

  // ── Expanded panel ──────────────────────────────────────────────
  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-50 flex flex-col",
        "rounded-xl border border-border shadow-2xl",
        "max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)]",
        "overflow-hidden",
      )}
      style={{
        background: "var(--background-base)",
        width: `${widgetWidth}px`,
        height: `${widgetHeight}px`,
      }}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 border-b border-current/20 relative">
        <button
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
          className="mr-1 rounded p-1 text-text-secondary hover:text-text-primary hover:bg-midground/10 transition-colors cursor-nwse-resize"
          aria-label="Resize"
          title="Drag to resize"
        >
          <ChevronDown className="h-3.5 w-3.5 rotate-[135deg]" />
        </button>
        <MessageSquare className="h-4 w-4 shrink-0 text-midground" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-midground">
          Chat
        </span>
        <WidgetProfilePicker value={profile} onChange={setProfile} />
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => store.setMinimized(true)}
            className="rounded p-1 text-text-secondary hover:text-text-primary hover:bg-midground/10 transition-colors"
            aria-label="Minimise"
            title="Minimise"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => store.setMinimized(true)}
            className="rounded p-1 text-text-secondary hover:text-text-primary hover:bg-midground/10 transition-colors"
            aria-label="Close"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showHistory ? (
          /* ── History panel ──────────────────────────────────── */
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="shrink-0 px-3 pt-2 pb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Chat history</span>
              <Button
                size="sm"
                onClick={() => {
                  void store.selectSession(null);
                  setShowHistory(false);
                }}
                prefix={<Plus className="h-3 w-3" />}
                className="text-[11px] h-6 px-2"
              >
                New chat
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-1">
              {!hydrated && (
                <div className="flex items-center justify-center py-6 text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
              {hydrated && sessions.length === 0 && (
                <div className="px-3 py-6 text-xs text-text-tertiary text-center">
                  No previous chats
                </div>
              )}
              {sessions.map((s) => (
                <SessionListItem
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onSelect={() => {
                    void store.selectSession(s.id);
                    setShowHistory(false);
                  }}
                  onDelete={() => void store.deleteSession(s.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          /* ── Chat view ──────────────────────────────────────── */
          <>
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
              {loading && visibleMessages.length === 0 && (
                <div className="flex items-center justify-center py-8 text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  <span className="text-xs">Loading…</span>
                </div>
              )}
              {!loading && visibleMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-text-tertiary">
                  <MessageSquare className="h-8 w-8 mb-2 opacity-25" />
                  <p className="text-xs">Start a conversation</p>
                </div>
              )}
              {visibleMessages.map((msg, i) => (
                <ChatBubble key={i} message={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="shrink-0 border-t border-current/10 px-3 py-2">
              <div className="flex items-end gap-2">
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={composer}
                  onChange={handleComposerChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Message… (Shift+Enter for new line)"
                  disabled={loading}
                  className={cn(
                    "flex-1 min-w-0 resize-none rounded-lg border border-border bg-surface px-3 py-1.5",
                    "text-xs text-text-primary placeholder:text-text-tertiary",
                    "outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20",
                    "transition-colors overflow-hidden leading-relaxed",
                    loading && "opacity-50",
                  )}
                  style={{ maxHeight: "120px" }}
                />
                <Button
                  size="sm"
                  disabled={!composer.trim() || loading}
                  onClick={handleSend}
                  className="shrink-0 mb-0.5"
                  aria-label="Send"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-current/10 px-3 py-1.5 flex items-center justify-between">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
        >
          {showHistory ? "← Back to chat" : `History (${sessions.length})`}
        </button>
        {!showHistory && activeSessionId && (
          <button
            onClick={() => void store.selectSession(null)}
            className="text-[10px] text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
          >
            <Plus className="h-2.5 w-2.5" />
            New chat
          </button>
        )}
      </div>
    </div>
  );
}
