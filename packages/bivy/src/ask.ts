import * as prompts from "@clack/prompts";
import { type AskSecret, type CredentialSpec, credential } from "./credentials.js";

/**
 * How `bivy init` and `bivy configure` ask (D93): one plain sentence per
 * question, arrow-key lists where there is a choice, hidden input for
 * credentials. Every ordinary question also has a flag, so Claude can
 * drive bivy without a terminal. Two kinds of question never have one, and
 * need a person at a terminal: a secret shown once, and a typed consent
 * (rule 5): a flag would let a script, or Claude, agree in the owner's name.
 */

export class AskError extends Error {}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Asker {
  /** A person is at a terminal. */
  readonly tty: boolean;
  /** The flag's value when given (and valid), else an arrow-key list. */
  select<T extends string>(flag: string, message: string, choices: Choice<T>[]): Promise<T>;
  /** The flag's value when given, else a line typed in. `check` returns why an answer is refused. */
  text(flag: string, message: string, options?: { initial?: string; placeholder?: string; check?: (value: string) => string | undefined }): Promise<string>;
  /** A credential from its file, else typed with hidden input and kept (credentials.ts). */
  secret(spec: CredentialSpec): Promise<string>;
  /** A typed word, for consents and secrets shown once: terminal only, never a flag. */
  typed(message: string, expected: string): Promise<boolean>;
  log(message: string): void;
}

const cancelled = () => new AskError("cancelled: nothing more was done");

export function terminalAsker(flags: Record<string, string | undefined>, tty: boolean, log: (message: string) => void = console.log): Asker {
  const askSecret: AskSecret | undefined = tty
    ? async (message) => {
        const answer = await prompts.password({ message });
        return prompts.isCancel(answer) ? undefined : answer;
      }
    : undefined;
  return {
    tty,
    async select(flag, message, choices) {
      const given = flags[flag];
      if (given !== undefined) {
        const choice = choices.find((entry) => entry.value === given);
        if (!choice) throw new AskError(`--${flag} must be one of: ${choices.map((entry) => entry.value).join(", ")}`);
        return choice.value;
      }
      if (!tty) throw new AskError(`${message} Pass --${flag} <${choices.map((entry) => entry.value).join("|")}>.`);
      // Typed loosely: clack's option type is conditional on T, which a generic cannot satisfy.
      const answer = await prompts.select({ message, options: choices.map((entry) => ({ value: entry.value, label: entry.label, ...(entry.hint ? { hint: entry.hint } : {}) })) as never });
      if (prompts.isCancel(answer)) throw cancelled();
      return answer as typeof choices[number]["value"];
    },
    async text(flag, message, options = {}) {
      const given = flags[flag];
      if (given !== undefined) {
        const problem = options.check?.(given);
        if (problem) throw new AskError(`--${flag}: ${problem}`);
        return given;
      }
      if (!tty) throw new AskError(`${message} Pass --${flag} <value>.`);
      const answer = await prompts.text({
        message,
        ...(options.initial ? { initialValue: options.initial } : {}),
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
        ...(options.check ? { validate: (value: string | undefined) => options.check?.((value ?? "").trim()) } : {}),
      });
      if (prompts.isCancel(answer)) throw cancelled();
      return answer.trim();
    },
    secret: (spec) => credential(spec, askSecret, log),
    async typed(message, expected) {
      if (!tty) throw new AskError(`${message}\nThis needs a person at a terminal (no flag can answer it): run the same command in a terminal.`);
      const answer = await prompts.text({ message });
      if (prompts.isCancel(answer)) throw cancelled();
      return answer.trim() === expected;
    },
    log,
  };
}
