import { useState, useRef, useId, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface TagInputProps {
  value?: string[];
  tags?: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  maxTags?: number;
}

export function TagInput({
  value,
  tags,
  onChange,
  placeholder = "Type and press Enter...",
  suggestions = [],
  maxTags,
}: TagInputProps) {
  const currentTags = value ?? tags ?? [];
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const addTag = (tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed || currentTags.includes(trimmed)) return;
    if (maxTags && currentTags.length >= maxTags) return;
    onChange([...currentTags, trimmed]);
    setInput("");
    setShowSuggestions(false);
    setActiveSuggestion(-1);
  };

  const removeTag = (tag: string) => {
    onChange(currentTags.filter((t) => t !== tag));
  };

  const filtered = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(input.toLowerCase()) && !currentTags.includes(s),
  ).slice(0, 10);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (activeSuggestion >= 0 && filtered[activeSuggestion]) {
        addTag(filtered[activeSuggestion]);
      } else {
        addTag(input);
      }
    } else if (e.key === "Backspace" && !input && currentTags.length > 0) {
      removeTag(currentTags[currentTags.length - 1]);
    } else if (e.key === "ArrowDown" && showSuggestions && filtered.length > 0) {
      e.preventDefault();
      setActiveSuggestion((prev) => (prev + 1) % filtered.length);
    } else if (e.key === "ArrowUp" && showSuggestions && filtered.length > 0) {
      e.preventDefault();
      setActiveSuggestion((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setActiveSuggestion(-1);
    }
  };

  const isExpanded = showSuggestions && input.length > 0 && filtered.length > 0;

  return (
    <div className="relative">
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-[38px] px-2 py-1.5 bg-surface-base border border-border-default rounded-md focus-within:border-accent focus-within:shadow-[0_0_0_1px_var(--color-accent)] transition-colors cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {currentTags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface-overlay text-text-secondary rounded-md border border-border-default"
          >
            {tag}
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="p-1 min-w-[24px] min-h-[24px] flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
              aria-label={`Remove tag ${tag}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
            setActiveSuggestion(-1);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => { setShowSuggestions(false); setActiveSuggestion(-1); }, 200)}
          placeholder={currentTags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[80px] bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted p-0"
          style={{ boxShadow: "none" }}
          role="combobox"
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? listboxId : undefined}
          aria-activedescendant={activeSuggestion >= 0 ? `${listboxId}-${activeSuggestion}` : undefined}
          aria-autocomplete="list"
        />
      </div>

      {/* Suggestions dropdown */}
      {isExpanded && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto glass-dropdown border border-border-default rounded-md"
        >
          {filtered.map((suggestion, i) => (
            <button
              key={suggestion}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === activeSuggestion}
              className={`w-full text-left px-3 py-2 min-h-[var(--touch-target-min)] text-xs transition-colors ${
                i === activeSuggestion
                  ? "bg-surface-overlay text-text-primary"
                  : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
