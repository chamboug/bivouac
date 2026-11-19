import * as prompts from "@clack/prompts";
import { Cancelled, type Choice, type Guide, type Progress } from "./guide.js";

/**
 * The guide and the progress of a person at a terminal (clack), or plain
 * lines when nobody is: a script, Claude, a log file.
 */

export const interactive = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

function answered<T>(value: T): Exclude<T, symbol> {
  if (prompts.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

export const terminalGuide: Guide = {
  async select<T extends string>(message: string, choices: Choice<T>[]): Promise<T> {
    const options = choices.map(({ value, label, hint }) => (hint ? { value, label, hint } : { value, label })) as Parameters<typeof prompts.select<T>>[0]["options"];
    return answered(await prompts.select<T>({ message, options }));
  },
  async confirm(message: string): Promise<boolean> {
    return answered(await prompts.confirm({ message, initialValue: false }));
  },
  async secret(message: string): Promise<string | undefined> {
    return answered(await prompts.password({ message })) || undefined;
  },
};

/**
 * A spinner of our own: clack's puts the keyboard in raw mode and turns
 * Escape or Ctrl-C into a silent exit with code 0, skipping every clean-up
 * and reminder (rule 6 review). This one only draws; Ctrl-C stays a normal
 * interruption, which the command answers (onInterrupt).
 */
class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private readonly began = Date.now();

  constructor(private readonly sentence: string) {
    this.draw();
    this.timer = setInterval(() => this.draw(), 120);
  }

  private draw(): void {
    const seconds = Math.round((Date.now() - this.began) / 1000);
    const line = `${FRAMES[this.frame++ % FRAMES.length]}  ${this.sentence}… ${seconds > 2 ? `(${duration(seconds)})` : ""}`;
    // One row only: a wrapped line could not be erased, and would stay cut on screen.
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
    process.stdout.write(`\r\x1b[2K${line.length > width ? `${line.slice(0, width - 1)}…` : line}`);
  }

  /** Erases the spinner's line, leaving the cursor at its start. */
  clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write("\r\x1b[2K");
  }

  end(symbol: string, text: string): void {
    this.clear();
    process.stdout.write(`${symbol}  ${text}\n`);
  }
}

const FRAMES = ["◒", "◐", "◓", "◑"];

/** A spinner per step; a message printed meanwhile goes above it, and the spinner carries on. */
export class TerminalProgress implements Progress {
  private spinner: Spinner | undefined;
  private sentence = "";
  private inStep = false;

  constructor(private readonly tty: boolean) {}

  start(sentence: string): void {
    this.sentence = sentence;
    this.inStep = true;
    if (!this.tty) {
      console.log(`· ${sentence}…`);
      return;
    }
    this.spinner = new Spinner(sentence);
  }

  stop(sentence: string, seconds: number): void {
    this.inStep = false;
    if (this.spinner) this.spinner.end("✓", `${sentence}${seconds >= 5 ? ` (${duration(seconds)})` : ""}`);
    this.spinner = undefined;
  }

  fail(sentence: string): void {
    this.inStep = false;
    if (this.spinner) this.spinner.end("✗", sentence);
    else if (!this.tty) console.log(`✗ ${sentence}`);
    this.spinner = undefined;
  }

  /** Anything said while a step runs. */
  log = (message: string): void => {
    if (!this.spinner) {
      console.log(message);
      return;
    }
    this.spinner.clear();
    console.log(message);
    this.spinner = new Spinner(this.sentence);
  };

  /** Before a question: a spinner must not draw over it. */
  pause(): void {
    this.spinner?.clear();
    this.spinner = undefined;
  }

  /** After a question asked in the middle of a step: the step's spinner again. */
  resume(): void {
    if (!this.tty || !this.inStep || this.spinner) return;
    this.spinner = new Spinner(this.sentence);
  }

  /** The guide, with the spinner out of the way of each question. */
  around(guide: Guide): Guide {
    const quiet = async <T>(ask: () => Promise<T>): Promise<T> => {
      this.pause();
      try {
        return await ask();
      } finally {
        this.resume();
      }
    };
    return {
      select: (message, choices) => quiet(() => guide.select(message, choices)),
      confirm: (message) => quiet(() => guide.confirm(message)),
      secret: (message) => quiet(() => guide.secret(message)),
    };
  }
}

/**
 * Ctrl-C (or a SIGTERM) in the middle of a run: never silent. Says what is
 * left behind and how to carry on, then exits with 130, as an interrupted
 * command does. Returns the function that removes the handler.
 */
export function onInterrupt(progress: TerminalProgress, hint: () => string | undefined): () => void {
  const handler = (signal: NodeJS.Signals) => {
    progress.pause();
    const text = hint();
    process.stderr.write(`\n✗ Interrupted (${signal}).${text ? `\n${text}` : ""}\n`);
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}
