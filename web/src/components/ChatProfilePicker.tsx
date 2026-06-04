/**
 * ChatProfilePicker — drop-down to select a Hermes profile for the current
 * chat session. Profiles determine the model, provider, toolsets, skills,
 * and personality used by the agent.
 *
 * Mounted in the ChatSidebar, next to the model picker.
 *
 * Data source: `/api/profiles` fetched via the `api` client and exposed
 * through the `ChatStore` (or loaded directly in the sidebar).
 */
import { Fragment, useEffect, useState } from "react";
import { Check, ChevronDown, Users } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ProfileInfo } from "@/lib/api";

interface ChatProfilePickerProps {
  /** Currently selected profile name, or null for the active default. */
  value: string | null;
  /** Called when the user picks a profile. */
  onChange: (profileName: string | null) => void;
  /** Disable the picker (e.g. while not connected). */
  disabled?: boolean;
}

export function ChatProfilePicker({
  value,
  onChange,
  disabled = false,
}: ChatProfilePickerProps) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getProfiles()
      .then((res) => {
        if (!cancelled && res.profiles) {
          setProfiles(res.profiles);
        }
      })
      .catch(() => {
        // Profiles are cosmetic; fail silently.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = profiles.find((p) => p.name === value) ?? null;
  const label = selected
    ? selected.name
    : value ?? "default";

  return (
    <div className="relative">
      <Button
        ghost
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        suffix={
          <ChevronDown className="h-3 w-3 text-text-secondary" />
        }
        className="self-start min-w-0 px-0 py-0 normal-case tracking-normal text-sm font-medium hover:underline disabled:no-underline"
        title={
          selected
            ? `${selected.name} (${selected.model ?? "no model"})`
            : "use default profile"
        }
      >
        <Users className="mr-1 h-3 w-3 shrink-0 text-text-secondary" />
        <span className="truncate">{label}</span>
      </Button>

      {open && (
        <Fragment>
          {/* Backdrop click to close */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg">
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
              Profile
            </div>

            {loading && (
              <div className="px-2 py-3 text-xs text-text-secondary">
                loading…
              </div>
            )}

            {!loading && profiles.length === 0 && (
              <div className="px-2 py-3 text-xs text-text-secondary">
                no profiles found
              </div>
            )}

            {profiles.map((p) => {
              const active = p.name === value || (!value && p.is_default);
              return (
                <button
                  key={p.name}
                  onClick={() => {
                    onChange(p.is_default ? null : p.name);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-text hover:bg-midground/5",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center",
                      active ? "text-accent" : "text-transparent",
                    )}
                  >
                    {active && <Check className="h-3.5 w-3.5" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    {p.model && (
                      <div className="truncate text-[11px] text-text-tertiary">
                        {p.model.replace(/^[^/]+\//, "")}
                      </div>
                    )}
                  </div>

                  {p.is_default && (
                    <span className="shrink-0 rounded bg-midground/10 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
                      default
                    </span>
                  )}
                </button>
              );
            })}

            <div className="mt-1 border-t border-border/50" />

            <button
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-secondary transition-colors hover:text-text",
                value === null && "text-accent",
              )}
            >
              <Check
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  value === null ? "opacity-100" : "opacity-0",
                )}
              />
              System default
            </button>
          </div>
        </Fragment>
      )}
    </div>
  );
}