import type { Choice, Guide } from "./guide.js";

/** A person at the terminal, answering from a script; every question is recorded. */
export function scripted(answer: (message: string, choices: Choice<string>[]) => string | boolean | undefined) {
  const questions: { message: string; choices: Choice<string>[] }[] = [];
  const guide: Guide = {
    select: async <T extends string>(message: string, choices: Choice<T>[]) => {
      questions.push({ message, choices });
      const value = answer(message, choices);
      const found = choices.find((choice) => choice.value === value);
      if (!found) throw new Error(`no scripted answer among the choices of "${message}"`);
      return found.value;
    },
    confirm: async (message) => {
      questions.push({ message, choices: [] });
      return answer(message, []) === true;
    },
    secret: async (message) => {
      questions.push({ message, choices: [] });
      return answer(message, []) as string | undefined;
    },
  };
  return { guide, questions };
}
