import type { AppManifest } from "@bivouac/manifest";
import { describe, expect, it } from "vitest";
import type { Progress } from "./guide.js";
import { COPIES_OFFERED, readCopies, readPlan, restoreAppCommand, restoreCommand, when, type RestoreRemote, type RestoreRequest } from "./restore.js";
import { scripted } from "./scripted-guide.js";

const GIB = 1024 ** 3;
const app = (name: string, parts: { database?: boolean; volumes?: string[] }): AppManifest =>
  ({
    name,
    image: `ghcr.io/example/${name}:sha-1`,
    ...(parts.database ? { database: { extensions: [] } } : {}),
    volumes: Object.fromEntries((parts.volumes ?? []).map((volume) => [volume, `/data/${volume}`])),
  }) as unknown as AppManifest;

const APPS = [app("biblio", { database: true, volumes: ["books"] }), app("recettes", { database: true }), app("static", {})];

const line = (message: string, fields: Record<string, unknown> = {}) => JSON.stringify({ time: "2026-11-20T10:00:00Z", message, ...fields });

/** Nightly copies, one a day, the latest the 19th; and a safety copy in between. */
const LIST = [
  ...Array.from({ length: 20 }, (_, day) => line("copy", { id: `c0ffee${String(day + 1).padStart(2, "0")}`, time: `2026-10-${String(day + 10).padStart(2, "0")}T02:10:00Z`, tags: ["nightly"] })),
  line("copy", { id: "aaaa1111", time: "2026-11-19T02:10:00Z", tags: ["nightly"] }),
  line("copy", { id: "bbbb2222", time: "2026-11-19T12:00:00Z", tags: ["pre-restore", "app:biblio"] }),
].join("\n");

const PLAN = {
  app: "biblio",
  copy: "aaaa1111",
  taken: "2026-11-19T02:10:00Z",
  database: "biblio (the current one kept as bivouac_r261120100000_biblio)",
  volumes: ["bivouac-app-biblio_books"],
  restores: { database: true, files: true },
  databaseBytes: GIB / 2,
  neededBytes: 2.5 * GIB,
  freeBytes: 20 * GIB,
  interrupted: false,
  deployedAt: "2026-11-16T20:15:55Z",
};

const RUN = [
  line("app stopped", { app: "biblio", wasRunning: true }),
  line("safety copy sent", { copy: "dddd4444" }),
  line("database restored", { database: "biblio", kept: "bivouac_r261120100000_biblio" }),
  line("volume restored", { volume: "bivouac-app-biblio_books" }),
  line("restore done", { app: "biblio", copy: "aaaa1111" }),
];

function fakeServer(options: { plan?: Record<string, unknown>; run?: string[]; runStatus?: number; planStatus?: number; planOutput?: string } = {}) {
  const commands: string[] = [];
  const streamed: string[] = [];
  const remote: RestoreRemote = {
    run(command) {
      commands.push(command);
      if (command.includes("--list")) return { status: 0, stdout: LIST, stderr: "" };
      if (options.planStatus) return { status: options.planStatus, stdout: options.planOutput ?? "", stderr: "" };
      return { status: 0, stdout: [line("restore plan", { ...PLAN, ...options.plan }), line("nothing changed: add --yes to restore")].join("\n"), stderr: "" };
    },
    async stream(command, onLine) {
      streamed.push(command);
      for (const text of options.run ?? RUN) onLine(text);
      return { status: options.runStatus ?? 0, stderr: "" };
    },
  };
  return { remote, commands, streamed };
}

function recorder() {
  const said: string[] = [];
  const progress: Progress = {
    start: (sentence) => said.push(`… ${sentence}`),
    stop: (sentence) => said.push(`✓ ${sentence}`),
    fail: (sentence) => said.push(`✗ ${sentence}`),
  };
  return { said, progress, log: (message: string) => said.push(message) };
}

const request = (fields: Partial<RestoreRequest> = {}): RestoreRequest => ({ plan: false, ...fields });

/** A person at a terminal: the answers to each question, and what they type. */
function person(answers: Record<string, string>, typed = "biblio") {
  const { guide, questions } = scripted((message) => {
    const key = Object.keys(answers).find((start) => message.startsWith(start));
    return key ? answers[key] : undefined;
  });
  const typings: string[] = [];
  return {
    guide,
    questions,
    typings,
    typed: async (message: string) => {
      typings.push(message);
      return typed;
    },
  };
}

const ANSWERS = { "Which app": "biblio", "Which nightly copy": "aaaa1111", "What should go back": "both", "Carry on": "carry on" };

describe("the command run on the server", () => {
  it("is the reconciler's restore-app, every argument quoted", () => {
    expect(restoreAppCommand("biblio", ["--snapshot", "aaaa1111", "--yes"])).toBe(
      "docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-app biblio --snapshot aaaa1111 --yes",
    );
    expect(restoreAppCommand("biblio", ["--before", "2026-11-18; reboot"])).toContain("'2026-11-18; reboot'");
  });
});

describe("reading the server", () => {
  it("lists the copies newest first", () => {
    const copies = readCopies(LIST);
    expect(copies[0]?.id).toBe("bbbb2222");
    expect(copies[1]?.id).toBe("aaaa1111");
  });

  it("refuses a plan whose copy or date is not one", () => {
    const plan = (fields: Record<string, unknown>) => line("restore plan", { ...PLAN, ...fields });
    expect(() => readPlan(plan({ copy: "--yes" }))).toThrow(/no valid copy/);
    expect(() => readPlan(plan({ copy: undefined }))).toThrow(/no valid copy/);
    expect(() => readPlan(plan({ taken: "yesterday" }))).toThrow(/no valid date/);
  });

  it("refuses the plan of a reconciler too old to give the disk", () => {
    const old = line("restore plan", { copy: "aaaa1111", taken: "2026-11-19T02:10:00Z" });
    expect(() => readPlan(old)).toThrow(/too old/);
  });

  it("shows dates in the person's time zone", () => {
    expect(when("2026-11-19T02:12:00Z", "Europe/Paris")).toBe("Thu 19 Nov, 03:12");
  });
});

describe("bivy restore, with a person at the terminal", () => {
  it("asks the app, the copy and the part, shows the plan, and restores that exact copy once the name is typed", async () => {
    const server = fakeServer();
    const out = recorder();
    const at = person(ANSWERS);
    const code = await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed, timeZone: "Europe/Paris" }, request());
    expect(code).toBe(0);
    // Only apps with data are offered, then Pocket ID; at most 14 nightly copies, never a safety copy.
    expect(at.questions[0]?.choices.map((choice) => choice.value)).toEqual(["biblio", "recettes", "pocket-id"]);
    const copies = at.questions[1]?.choices.map((choice) => choice.value) ?? [];
    expect(copies).toHaveLength(COPIES_OFFERED);
    expect(copies[0]).toBe("aaaa1111");
    expect(copies).not.toContain("bbbb2222");
    // The plan is read for that copy, then the restore runs on it, with --yes only after the typed name.
    expect(server.commands.at(-1)).toMatch(/restore-app biblio --snapshot aaaa1111$/);
    expect(server.streamed).toEqual([expect.stringMatching(/restore-app biblio --snapshot aaaa1111 --yes$/)]);
    expect(at.typings[0]).toContain("type the app's name (biblio)");
    const text = out.said.join("\n");
    expect(text).toContain("today's is kept aside, as bivouac_r261120100000_biblio");
    expect(text).toContain("disk: about 2.5 GB needed, 20.0 GB free");
    expect(text).toContain("✓ Bringing the database back");
    expect(text).toContain("✓ Bringing the files back");
    expect(text).toContain("✓ Starting biblio and waiting for its health check");
    expect(text).toContain("To undo it: bivy restore biblio --snapshot dddd4444");
    expect(text).toContain("The replaced database is kept as bivouac_r261120100000_biblio");
  });

  it("restores one part only, and undoes that part only", async () => {
    const server = fakeServer({ plan: { restores: { database: true, files: false }, volumes: "untouched" }, run: [RUN[0], RUN[1], RUN[2], RUN[4]] as string[] });
    const out = recorder();
    const at = person({ ...ANSWERS, "What should go back": "database" });
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request())).toBe(0);
    expect(server.streamed[0]).toMatch(/--snapshot aaaa1111 --yes --only database$/);
    expect(out.said.join("\n")).toContain("To undo it: bivy restore biblio --snapshot dddd4444 --only database");
  });

  it("does not ask the part of an app that has only a database", async () => {
    const server = fakeServer({ plan: { app: "recettes", restores: { database: true, files: false }, volumes: "untouched" } });
    const at = person(ANSWERS, "recettes");
    await restoreCommand({ apps: APPS, remote: server.remote, ...recorder(), guide: at.guide, typed: at.typed }, request({ app: "recettes" }));
    expect(at.questions.some((question) => question.message.startsWith("What should go back"))).toBe(false);
  });

  it("changes nothing when the name typed is not the app's", async () => {
    const server = fakeServer();
    const out = recorder();
    const at = person(ANSWERS, "biblo");
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request())).toBe(1);
    expect(server.streamed).toEqual([]);
    expect(server.commands.some((command) => command.includes("--yes"))).toBe(false);
    expect(out.said.join("\n")).toContain("not confirmed: nothing was changed");
  });

  it("warns when the app was deployed after the copy, and stops if asked", async () => {
    const server = fakeServer({ plan: { deployedAt: "2026-11-19T18:00:00Z" } });
    const out = recorder();
    const at = person({ ...ANSWERS, "Carry on": "stop" });
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request())).toBe(1);
    expect(out.said.join("\n")).toContain("first put the previous image back");
    expect(at.typings).toEqual([]);
    expect(server.streamed).toEqual([]);
  });

  it("does not warn when the version is older than the copy", async () => {
    const out = recorder();
    const at = person(ANSWERS);
    await restoreCommand({ apps: APPS, remote: fakeServer().remote, ...out, guide: at.guide, typed: at.typed }, request());
    expect(at.questions.some((question) => question.message === "Carry on?")).toBe(false);
  });
});

describe("bivy restore refuses before changing anything", () => {
  const refused = async (plan: Record<string, unknown>, fields: Partial<RestoreRequest> = {}) => {
    const server = fakeServer({ plan });
    const out = recorder();
    const at = person(ANSWERS);
    const code = await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request(fields));
    expect(code).toBe(1);
    expect(at.typings).toEqual([]);
    expect(server.streamed).toEqual([]);
    return out.said.join("\n");
  };

  it("while a backup or another restore runs", async () => {
    expect(await refused({ busy: "backup" })).toContain("a backup is running on the server");
  });

  it("without enough free disk", async () => {
    expect(await refused({ freeBytes: GIB })).toContain("not enough free disk");
  });

  it("one part only, after an interrupted restore", async () => {
    expect(await refused({ interrupted: true }, { only: "files" })).toContain("only a restore of all its data");
  });

  it("an app without data, or unknown", async () => {
    expect(await refused({}, { app: "static" })).toContain("nothing to restore");
    expect(await refused({}, { app: "nope" })).toContain("no app 'nope'");
  });

  it("a malformed copy ID, before reaching the server", async () => {
    const server = fakeServer();
    const code = await restoreCommand({ apps: APPS, remote: server.remote, ...recorder() }, request({ app: "biblio", snapshot: "xyz; reboot" }));
    expect(code).toBe(1);
    expect(server.commands).toEqual([]);
  });

  it("when the server refuses the plan, and says why", async () => {
    const server = fakeServer({ planStatus: 1, planOutput: line("restore failed", { error: "no nightly copy at or before that date" }) });
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out }, request({ app: "biblio", before: "2020-01-01" }))).toBe(1);
    expect(out.said.join("\n")).toContain("no nightly copy at or before that date");
  });
});

describe("bivy restore, without a terminal (a script, Claude)", () => {
  it("reads the plan with --plan, the latest copy by default, and changes nothing", async () => {
    const server = fakeServer();
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out }, request({ app: "biblio", plan: true }))).toBe(0);
    expect(server.commands).toEqual([expect.stringMatching(/restore-app biblio$/)]);
    expect(server.streamed).toEqual([]);
    expect(out.said.join("\n")).toContain("Nothing was changed (--plan). To restore: bivy restore biblio --snapshot aaaa1111");
  });

  it("never restores: the confirmation is typed in a terminal", async () => {
    const server = fakeServer();
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out }, request({ app: "biblio", snapshot: "aaaa1111" }))).toBe(1);
    expect(server.streamed).toEqual([]);
    expect(out.said.join("\n")).toContain("confirmed by typing in a terminal");
  });

  it("asks for the app by name", async () => {
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: fakeServer().remote, ...out }, request())).toBe(1);
    expect(out.said.join("\n")).toContain("Apps with data: biblio, recettes");
  });
});

describe("bivy restore, when the run goes wrong", () => {
  const run = async (lines: string[], status: number) => {
    const server = fakeServer({ run: lines, runStatus: status });
    const out = recorder();
    const at = person(ANSWERS);
    const code = await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request());
    return { code, text: out.said.join("\n") };
  };

  it("says the server's reason, and where the data from before is", async () => {
    const { code, text } = await run([RUN[0], RUN[1], line("restore failed", { error: "restic restore of bivouac-app-biblio_books failed. The app stays stopped" })] as string[], 1);
    expect(code).toBe(1);
    expect(text).toContain("✗ Bringing the database back: restic restore of bivouac-app-biblio_books failed");
    expect(text).toContain("safety copy dddd4444: bivy restore biblio --snapshot dddd4444 puts it back");
  });

  it("offers no undo when the server changed nothing", async () => {
    const { code, text } = await run([RUN[0], RUN[1], line("restore stopped", { changed: false }), line("restore failed", { error: "copy aaaa1111 holds no dump of biblio: choose a later one. Nothing was changed" })] as string[], 1);
    expect(code).toBe(1);
    expect(text).toContain("Nothing was changed");
    expect(text).not.toContain("puts it back");
  });

  it("says a restored app that is not healthy, with the way back", async () => {
    const { code, text } = await run([...RUN, line("restore failed", { error: "the data is restored, but the app is not healthy" })], 1);
    expect(code).toBe(1);
    expect(text).toContain("✗ Starting biblio and waiting for its health check: the data is restored, but the app is not healthy");
    expect(text).toContain("bivy restore biblio --snapshot dddd4444 puts it back");
  });

  it("says a lost connection, and how to find out how it ended", async () => {
    const { code, text } = await run([RUN[0], RUN[1]] as string[], 255);
    expect(code).toBe(1);
    expect(text).toContain("the connection to the server was lost");
    expect(text).toContain("bivy restore biblio --plan says");
    expect(text).toContain("runbook, section 14");
  });
});

describe("bivy restore pocket-id (D110)", () => {
  const POCKET_PLAN = {
    app: "pocket-id",
    copy: "aaaa1111",
    taken: "2026-11-19T02:10:00Z",
    database: "bivouac_pocket_id (the current one kept as bivouac_r261120100000_bivouac_pocket_id)",
    volumes: "untouched",
    restores: { database: true, files: false },
    databaseBytes: GIB / 100,
    neededBytes: 1.1 * GIB,
    freeBytes: 20 * GIB,
    interrupted: false,
    deployedAt: "2026-11-19T18:00:00Z",
    image: "ghcr.io/pocket-id/pocket-id:v2.20.0@sha256:abc",
    pocketId: "unhealthy",
    users: 7,
  };
  const POCKET_RUN = [
    line("app stopped", { app: "pocket-id", wasRunning: true }),
    line("safety copy sent", { copy: "eeee5555" }),
    line("database restored", { database: "bivouac_pocket_id", kept: "bivouac_r261120100000_bivouac_pocket_id", users: 7 }),
    line("restore done", { app: "pocket-id", copy: "aaaa1111" }),
  ];
  const pocketAnswers = { "Which app": "pocket-id", "Which nightly copy": "aaaa1111", "Carry on": "carry on" };

  it("runs the reconciler's restore-pocket-id", () => {
    expect(restoreAppCommand("pocket-id", ["--snapshot", "aaaa1111", "--yes"])).toBe(
      "docker exec bivouac-reconciler node packages/reconciler/dist/main.js restore-pocket-id --snapshot aaaa1111 --yes",
    );
  });

  it("is offered beside the apps, warns about the order after an update, and restores once pocket-id is typed", async () => {
    const server = fakeServer({ plan: POCKET_PLAN, run: POCKET_RUN });
    const out = recorder();
    const at = person(pocketAnswers, "pocket-id");
    const code = await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed, timeZone: "Europe/Paris" }, request());
    expect(code).toBe(0);
    expect(at.questions[0]?.choices.map((choice) => choice.value)).toEqual(["biblio", "recettes", "pocket-id"]);
    // Never asked which part: Pocket ID has only a database.
    expect(at.questions.some((question) => question.message.startsWith("What should go back"))).toBe(false);
    expect(server.commands.at(-1)).toMatch(/restore-pocket-id --snapshot aaaa1111$/);
    expect(server.streamed).toEqual([expect.stringMatching(/restore-pocket-id --snapshot aaaa1111 --yes$/)]);
    expect(at.typings[0]).toContain("type pocket-id:");
    const text = out.said.join("\n");
    expect(text).toContain("Restoring Pocket ID, the sign-in, to the copy aaaa1111");
    expect(text).toContain("Pocket ID now: unhealthy, ghcr.io/pocket-id/pocket-id:v2.20.0, 7 accounts");
    expect(text).toContain("bivy pin reconciler <commit>");
    expect(text).not.toContain("works right now");
    expect(text).toContain("✓ Stopping Pocket ID");
    expect(text).toContain("✓ Bringing the database back");
    expect(text).toContain("✓ Starting Pocket ID and waiting for its health check");
    expect(text).toContain("✓ Pocket ID is back to the copy of Thu 19 Nov, 03:10.");
    expect(text).toContain("To undo it: bivy restore pocket-id --snapshot eeee5555");
  });

  it("stops when the previous reconciler is not back yet", async () => {
    const server = fakeServer({ plan: POCKET_PLAN });
    const at = person({ ...pocketAnswers, "Carry on": "stop" }, "pocket-id");
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...recorder(), guide: at.guide, typed: at.typed }, request({ app: "pocket-id" }))).toBe(1);
    expect(at.typings).toEqual([]);
    expect(server.streamed).toEqual([]);
  });

  it("says when Pocket ID works right now", async () => {
    const server = fakeServer({ plan: { ...POCKET_PLAN, pocketId: "healthy", deployedAt: "2026-11-01T00:00:00Z" } });
    const out = recorder();
    const at = person(pocketAnswers, "pocket-id");
    await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request({ app: "pocket-id", plan: true }));
    expect(out.said.join("\n")).toContain("Pocket ID works right now");
  });

  it("reads the plan without a terminal, and never restores there", async () => {
    const server = fakeServer({ plan: POCKET_PLAN });
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out }, request({ app: "pocket-id", plan: true }))).toBe(0);
    expect(server.commands).toEqual([expect.stringMatching(/restore-pocket-id$/)]);
    expect(out.said.join("\n")).toContain("To restore: bivy restore pocket-id --snapshot aaaa1111, in a terminal");
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...recorder() }, request({ app: "pocket-id", snapshot: "aaaa1111" }))).toBe(1);
    expect(server.streamed).toEqual([]);
  });

  it("refuses --only, and a name typed wrong", async () => {
    const out = recorder();
    expect(await restoreCommand({ apps: APPS, remote: fakeServer().remote, ...out }, request({ app: "pocket-id", only: "files" }))).toBe(1);
    expect(out.said.join("\n")).toContain("Pocket ID has only a database");
    const server = fakeServer({ plan: POCKET_PLAN });
    const at = person(pocketAnswers, "pocket id");
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...recorder(), guide: at.guide, typed: at.typed }, request({ app: "pocket-id" }))).toBe(1);
    expect(server.streamed).toEqual([]);
  });

  it("points to section 22 after a lost connection", async () => {
    const server = fakeServer({ plan: POCKET_PLAN, run: POCKET_RUN.slice(0, 2), runStatus: 255 });
    const out = recorder();
    const at = person(pocketAnswers, "pocket-id");
    expect(await restoreCommand({ apps: APPS, remote: server.remote, ...out, guide: at.guide, typed: at.typed }, request({ app: "pocket-id" }))).toBe(1);
    const text = out.said.join("\n");
    expect(text).toContain("bivy restore pocket-id --plan says");
    expect(text).toContain("Pocket ID then stays stopped");
    expect(text).toContain("runbook, section 22");
  });
});
