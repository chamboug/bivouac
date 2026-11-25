import { describe, expect, it } from "vitest";
import { capitalised, failed } from "./say.js";

describe("errors as bivy prints them", () => {
  it("start with a capital letter", () => {
    expect(failed("the server did not answer: timeout")).toBe("✗ The server did not answer: timeout");
    expect(failed("cannot find the server: auth.example.org does not resolve")).toBe("✗ Cannot find the server: auth.example.org does not resolve");
    expect(failed("Already capitalised.")).toBe("✗ Already capitalised.");
  });

  it("leave a command, a path, a key or a flag as typed", () => {
    expect(capitalised("bivy restore has no --yes")).toBe("bivy restore has no --yes");
    expect(capitalised("butane/server.bu is missing")).toBe("butane/server.bu is missing");
    expect(capitalised("pocket_id.encryption_key is never changed by bivy")).toBe("pocket_id.encryption_key is never changed by bivy");
    expect(capitalised("--only takes 'database' or 'files'")).toBe("--only takes 'database' or 'files'");
    expect(capitalised("a backup is running")).toBe("A backup is running");
    expect(capitalised("")).toBe("");
  });
});
