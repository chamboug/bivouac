import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Instance, type ValidationError, generateCaddyfile, loadInstance, withStatusApp } from "@bivouac/manifest";
import { CaddyError, validateCaddyfile } from "./caddy.js";
import { EXAMPLE_IPV6, IPV6_PLACEHOLDER, IgnitionError, buildButane, compileButane } from "./ignition.js";

/**
 * The checks of `bivy validate`: the manifests, then the Butane config and
 * the Caddyfile built from them. Problems are returned, never thrown, except
 * a fault of bivy itself.
 */
export function validateInstance(root: string): { instance: Instance; errors: ValidationError[] } {
  const instance = loadInstance(root);
  const errors = [...instance.errors];
  // The server runs this image with the Docker socket: a tag can be pushed
  // again by whoever can publish the package, a digest names one content
  // (D61). Required here, at merge time, rather than in the schema, so a
  // reconciler that reads an older platform.yml still finds its version.
  if (instance.platform && !/@sha256:[a-f0-9]{64}$/.test(instance.platform.reconciler.image)) {
    errors.push({
      file: "platform.yml",
      message: "reconciler.image must be pinned by digest (ghcr.io/<owner>/bivouac-reconciler:v<x.y.z>@sha256:<digest> or :sha-<commit>@…, D61, D109)",
    });
  }
  // The status page holds the token of the reconciler's API: the same rule.
  const status = instance.platform?.status;
  if (status && !/@sha256:[a-f0-9]{64}$/.test(status.image)) {
    errors.push({
      file: "platform.yml",
      message: "status.image must be pinned by digest (ghcr.io/<owner>/bivouac-status:v<x.y.z>@sha256:<digest> or :sha-<commit>@…)",
    });
  }
  if (instance.sshKeys && instance.platform) {
    const butane = join(root, "butane", "server.bu");
    try {
      // A missing file is buildButane's own error.
      const placeholder = existsSync(butane) && readFileSync(butane, "utf8").includes(IPV6_PLACEHOLDER);
      compileButane(buildButane(root, instance.platform, instance.sshKeys, placeholder ? EXAMPLE_IPV6 : undefined));
    } catch (error) {
      if (!(error instanceof IgnitionError)) throw error;
      errors.push({ file: "butane/server.bu", message: error.message });
    }
  }
  // Only check the Caddyfile when the manifests themselves are valid: an
  // invalid manifest is left out of the instance and would hide its route.
  if (instance.platform && errors.length === 0) {
    const generated = generateCaddyfile(instance.platform, withStatusApp(instance.platform, instance.apps), instance.sites);
    errors.push(...generated.errors);
    if (generated.errors.length === 0) {
      try {
        validateCaddyfile(generated.caddyfile);
      } catch (error) {
        if (!(error instanceof CaddyError)) throw error;
        errors.push({ file: "(generated Caddyfile)", message: error.message });
      }
    }
  }
  return { instance, errors };
}
