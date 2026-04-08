/**
 * Companion Widget — ASCII art pet in the web UI.
 * Deterministic from user email, shows in bottom-right corner.
 */
import { useState, useEffect } from "react";

const SPECIES = [
  "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin",
  "turtle", "ghost", "axolotl", "capybara", "robot", "rabbit", "mushroom", "chonk",
];

const SPRITES: Record<string, string> = {
  duck: "  (\u00b7  \u00b7)>\n  /|  |\\\n  d   b",
  cat: " /\\ /\\\n( \u00b7 \u00b7 )\n ( ^ )",
  blob: ".---.\n( \u00b7 \u00b7 )\n '---'",
  ghost: ".---.\n( \u00b7 \u00b7 )\n/\\/\\/\\/",
  robot: "[===]\n|\u00b7 \u00b7|\n|___|",
  owl: " {o}\n(\u25c9 \u25c9)\n/{Y}\\",
  penguin: " .--.\n(\u00b7 \u00b7 )\n/####\\",
  dragon: " /\\/\\\n(\u00b7 \u00b7 )~\n {===}",
  octopus: ".oOo.\n( \u00b7 \u00b7 )\n~/|||\\~",
  turtle: " ___\n(\u00b7 \u00b7)\n/===\\",
  goose: " ___\n(\u00b7 \u00b7)~\n /||\\",
  axolotl: "\\(~ ~)/\n(\u00b7 \u00b7 )\n(===)",
  capybara: ".===.\n(\u00b7 \u00b7 )\n(---)",
  rabbit: "(\\(\\\n( \u00b7 \u00b7)\no(\")\")",
  mushroom: ".oOOo.\n/\u00b7 \u00b7 \u00b7\\\n|_____|",
  chonk: ",===,\n/ \u00b7 \u00b7 \\\n|~~~|",
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function CompanionWidget({ userEmail }: { userEmail: string }) {
  const [tick, setTick] = useState(0);
  const [reaction, setReaction] = useState("*waves*");

  const seed = hashStr(userEmail + "oneshots-2026");
  const species = SPECIES[seed % SPECIES.length];
  const sprite = SPRITES[species] || SPRITES.blob;
  const isShiny = seed % 100 === 0;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => setReaction(""), 8000);
    return () => clearTimeout(timeout);
  }, [reaction]);

  const fidget = tick % 7 === 3;

  return (
    <div
      className="fixed bottom-4 right-4 font-mono text-xs opacity-60 hover:opacity-100 transition-opacity cursor-pointer group"
      onClick={() => setReaction(["*purrs*", "Hey!", "*blink*", "Nice work!"][tick % 4])}
    >
      {reaction && (
        <div className="absolute -top-8 right-0 bg-surface-secondary/90 border border-white/10 rounded-lg px-2 py-1 text-xs text-text-secondary whitespace-nowrap">
          {reaction}
        </div>
      )}
      <pre
        className={`text-text-tertiary ${isShiny ? "text-yellow-400" : ""} ${fidget ? "translate-x-0.5" : ""} transition-transform`}
      >
        {sprite}
      </pre>
      <div className="text-center text-text-tertiary text-[10px] opacity-0 group-hover:opacity-100">
        {species}
        {isShiny ? " \u2728" : ""}
      </div>
    </div>
  );
}
