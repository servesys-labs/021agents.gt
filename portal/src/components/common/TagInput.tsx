import { useState, useRef, type KeyboardEvent } from "react";
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
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed || currentTags.includes(trimmed)) return;
    if (maxTags && currentTags.length >= maxTags) return;
    onChange([...currentTags, trimmed]);
    setInput("");
    setShowSuggestions(false);
  };

  const removeTag = (tag: string) => {
    onChange(currentTags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
    } else if (e.key === "Backspace" && !input && currentTags.length > 0) {
      removeTag(currentTags[currentTags.length - 1]);
    }
  };

  const filtered = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(input.toLowerCase()) && !currentTags.includes(s),
  );

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
              className="text-text-muted hover:text-text-primary transition-colors"
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
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder={currentTags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[80px] bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted p-0"
          style={{ boxShadow: "none" }}
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && input && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto bg-surface-raised border border-border-default rounded-md shadow-lg">
          {filtered.slice(0, 10).map((suggestion) => (
            <button
              key={suggestion}
              className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors"
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
