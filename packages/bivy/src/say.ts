/** Words left as they are at the start of a sentence: commands and tools, as typed. */
const AS_TYPED = new Set(["bivy", "restic", "sops", "ssh", "git", "docker"]);

/** The sentence with a capital letter, unless it starts with a name written as typed (a command, a path, a key). */
export function capitalised(sentence: string): string {
  const first = /^[a-z]+(?=[\s:,;'’]|$)/.exec(sentence)?.[0];
  if (!first || AS_TYPED.has(first)) return sentence;
  return `${first.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** An error as bivy prints it: `✗ ` and a capital letter, whatever wrote the message. */
export const failed = (message: string): string => `✗ ${capitalised(message)}`;
