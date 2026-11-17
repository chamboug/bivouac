import { defineEventHandler } from "h3";

// The platform's health check: this page has no database, so being up is enough.
export default defineEventHandler(() => ({ status: "ok" }));
