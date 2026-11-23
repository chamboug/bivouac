<script setup lang="ts">
interface Container {
  name: string;
  kind: "app" | "platform";
  image: string;
  state: string;
  health: string | null;
  startedAt?: string;
  restarts: number;
  oomKilled: boolean;
  memory: { usedBytes: number; limitBytes: number } | null;
}
interface State {
  generatedAt: string;
  reconciler: { image: string | null; startedAt: string };
  lastPass: { at: string; status: string; commit?: string; changes: string[]; failures: { app: string; message: string }[] } | null;
  containers: Container[];
  backup: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    restoreError: string | null;
    maintenanceError: string | null;
  } | null;
  incidents: { key: string; message: string; since: string | null }[];
  host: {
    disk: { totalBytes: number; availableBytes: number };
    memory: { totalBytes: number | null; availableBytes: number | null };
    swap: { totalBytes: number | null; freeBytes: number | null };
  };
}

const { data: state, error, refresh } = await useFetch<State>("/api/state");
const timer = ref<ReturnType<typeof setInterval>>();
onMounted(() => (timer.value = setInterval(() => refresh(), 30_000)));
onBeforeUnmount(() => clearInterval(timer.value));

const toast = useToast();
const syncing = ref(false);
async function sync() {
  syncing.value = true;
  try {
    const answer = await $fetch<{ started: boolean; reason: string | null }>("/api/sync", { method: "POST" });
    toast.add({ title: answer.started ? "Sync started" : "Not started", description: answer.reason ?? "A pass runs now; the page refreshes in a few seconds." });
    if (answer.started) setTimeout(() => refresh(), 8_000);
  } catch (failure) {
    toast.add({ title: "Sync failed", description: (failure as Error).message, color: "error" });
  } finally {
    syncing.value = false;
  }
}

const selected = ref<string>();
const logs = ref("");
const logsLoading = ref(false);
async function showLogs(name: string) {
  selected.value = name;
  logsLoading.value = true;
  try {
    logs.value = await $fetch<string>(`/api/logs/${encodeURIComponent(name)}`, { query: { lines: 300 }, responseType: "text" });
  } catch (failure) {
    logs.value = `Could not read the logs: ${(failure as Error).message}`;
  } finally {
    logsLoading.value = false;
  }
}

const bytes = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "–";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(value / 1024 ** 2)} MiB`;
};
const percent = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
};
// The name and version only; the full reference (registry, owner, digest) is in the tooltip.
const shortImage = (image: string) => image.replace(/@sha256:[a-f0-9]+$/, "").split("/").pop() ?? image;
// A state is always a word and an icon, never a colour alone (docs/brand).
const ICONS = { success: "i-lucide-circle-check", warning: "i-lucide-triangle-alert", error: "i-lucide-circle-x" } as const;
const status = (container: Container) => {
  const of = (label: string, color: keyof typeof ICONS) => ({ label, color, icon: ICONS[color] });
  if (container.state !== "running") return of(container.state, "error");
  if (container.health === "unhealthy") return of("unhealthy", "error");
  if (container.health === "starting") return of("starting", "warning");
  return of(container.health ?? "running", "success");
};

// Postgres's logs are never served: a failed statement can hold a password.
const hasLogs = (container: Container) => container.name !== "bivouac-postgres";

// The platform first: if one of its pieces is down, every app is.
const groups = computed(() => {
  const containers = state.value?.containers ?? [];
  return [
    { title: "Platform", column: "Service", empty: "", containers: containers.filter((entry) => entry.kind !== "app") },
    { title: "Apps", column: "App", empty: "No app is hosted yet.", containers: containers.filter((entry) => entry.kind === "app") },
  ];
});

const disk = computed(() => {
  const host = state.value?.host;
  if (!host) return 0;
  return percent(host.disk.totalBytes - host.disk.availableBytes, host.disk.totalBytes);
});
const memory = computed(() => {
  const host = state.value?.host.memory;
  if (!host?.totalBytes || host.availableBytes === null) return 0;
  return percent(host.totalBytes - host.availableBytes, host.totalBytes);
});
// The light in the tent is on while the reconciler passes; after 5 minutes without a pass, it says so.
const passLate = computed(() => {
  const at = state.value?.lastPass?.at;
  return !at || Date.now() - new Date(at).getTime() > 5 * 60 * 1000;
});
const somethingDown = computed(
  () => Boolean(error.value) || (state.value?.incidents.length ?? 0) > 0 || (state.value?.containers ?? []).some((entry) => status(entry).color === "error"),
);
useHead({
  title: () => (somethingDown.value ? "Down · Bivouac status" : "Bivouac status"),
  link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
});

const backupLate = computed(() => {
  const last = state.value?.backup?.lastSuccessAt;
  return !last || Date.now() - new Date(last).getTime() > 30 * 3600 * 1000;
});
</script>

<template>
  <div>
  <header class="border-b border-default bg-[#151c1a] text-[#f5f2eb]">
    <UContainer class="flex h-14 items-center justify-between gap-4">
      <img src="/bivouac-logo-night.svg" alt="Bivouac" class="h-6 w-auto">
      <span v-if="state" class="flex items-center gap-2 text-sm" :class="passLate ? 'text-[#e3b23c]' : 'text-[#f5f2eb]/85'">
        <UIcon v-if="passLate" name="i-lucide-triangle-alert" class="size-4" />
        <span v-else class="bv-dot" aria-hidden="true" />
        Last pass {{ ago(state.lastPass?.at) }}
      </span>
    </UContainer>
  </header>
  <UContainer class="py-8 space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Status</h1>
        <p class="text-sm text-muted">
          Last pass {{ ago(state?.lastPass?.at) }}<template v-if="state?.lastPass">: {{ state.lastPass.status }}</template>
          · reconciler <span class="font-mono">{{ state?.reconciler.image ? shortImage(state.reconciler.image) : "(local)" }}</span>
        </p>
      </div>
      <div class="flex gap-2">
        <UButton icon="i-lucide-refresh-cw" :loading="syncing" @click="sync">Sync now</UButton>
        <form method="post" action="/auth/logout">
          <UButton type="submit" color="neutral" variant="outline">Sign out</UButton>
        </form>
      </div>
    </div>

    <UAlert v-if="error" color="error" title="The status cannot be read" :description="error.message" />

    <template v-if="state">
      <UAlert
        v-for="incident in state.incidents"
        :key="incident.key"
        color="error"
        icon="i-lucide-triangle-alert"
        :title="incident.message"
        :description="incident.since ? `Since ${ago(incident.since)} (${incident.key})` : incident.key"
      />
      <UAlert
        v-for="failure in state.lastPass?.failures ?? []"
        :key="failure.app + failure.message"
        color="warning"
        :title="failure.app"
        :description="failure.message"
      />

      <div class="grid gap-4 sm:grid-cols-3">
        <UCard>
          <p class="text-sm text-muted">Disk</p>
          <p class="font-mono text-xl font-medium tabular-nums" :class="disk >= 80 ? 'text-error' : ''">{{ disk }} %</p>
          <p class="text-sm text-muted">{{ bytes(state.host.disk.availableBytes) }} free of {{ bytes(state.host.disk.totalBytes) }}</p>
        </UCard>
        <UCard>
          <p class="text-sm text-muted">Memory</p>
          <p class="font-mono text-xl font-medium tabular-nums">{{ memory }} %</p>
          <p class="text-sm text-muted">
            {{ bytes(state.host.memory.availableBytes) }} available of {{ bytes(state.host.memory.totalBytes) }}
            <template v-if="state.host.swap.totalBytes">
              · swap {{ bytes((state.host.swap.totalBytes ?? 0) - (state.host.swap.freeBytes ?? 0)) }} used
            </template>
          </p>
        </UCard>
        <UCard>
          <p class="text-sm text-muted">Last backup</p>
          <p class="font-mono text-xl font-medium tabular-nums" :class="backupLate ? 'text-error' : ''">{{ ago(state.backup?.lastSuccessAt) }}</p>
          <p v-if="state.backup?.lastError" class="text-sm text-error">{{ state.backup.lastError }}</p>
          <p v-if="state.backup?.restoreError" class="text-sm text-error">Restore test: {{ state.backup.restoreError }}</p>
          <p v-if="state.backup?.maintenanceError" class="text-sm text-error">Clean-up: {{ state.backup.maintenanceError }}</p>
        </UCard>
      </div>

      <section v-for="group in groups" :key="group.title" class="space-y-2">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-muted">{{ group.title }}</h2>
        <p v-if="group.containers.length === 0" class="text-sm text-muted">{{ group.empty }}</p>
        <UCard v-else :ui="{ body: 'p-0 sm:p-0' }">
        <div class="overflow-x-auto">
          <table class="w-full text-sm sm:table-fixed">
            <thead class="text-left text-muted">
              <tr>
                <th class="sm:w-[22%] p-3">{{ group.column }}</th>
                <th class="hidden sm:w-[30%] p-3 sm:table-cell">Version</th>
                <th class="sm:w-[18%] p-3">State</th>
                <th class="sm:w-[16%] p-3">Memory</th>
                <th class="hidden sm:w-[12%] p-3 sm:table-cell">Started</th>
                <th class="sm:w-[12%] p-3">Restarts</th>
                <th class="hidden sm:w-[8%] p-3 sm:table-cell" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="container in group.containers" :key="container.name" class="border-t border-default">
                <td class="p-3 font-medium">
                  <button v-if="hasLogs(container)" type="button" class="text-left hover:underline" title="Show its logs" @click="showLogs(container.name)">
                    {{ container.name.replace(/^bivouac-(app-)?/, "") }}
                  </button>
                  <span v-else>{{ container.name.replace(/^bivouac-(app-)?/, "") }}</span>
                </td>
                <td class="hidden truncate p-3 font-mono text-xs sm:table-cell" :title="container.image">{{ shortImage(container.image) }}</td>
                <td class="p-3">
                  <UBadge :color="status(container).color" :icon="status(container).icon" variant="subtle">{{ status(container).label }}</UBadge>
                  <UBadge v-if="container.oomKilled" color="error" icon="i-lucide-circle-x" variant="subtle" class="ml-1">out of memory</UBadge>
                </td>
                <td class="p-3">
                  <template v-if="container.memory">
                    {{ bytes(container.memory.usedBytes) }}
                    <span v-if="container.memory.limitBytes < (state.host.memory.totalBytes ?? Infinity)" class="text-muted">
                      / {{ bytes(container.memory.limitBytes) }}
                    </span>
                  </template>
                  <template v-else>–</template>
                </td>
                <td class="hidden p-3 sm:table-cell">{{ ago(container.startedAt) }}</td>
                <td class="p-3" :class="container.restarts > 0 ? 'text-warning' : ''">{{ container.restarts }}</td>
                <td class="hidden p-3 text-right sm:table-cell">
                  <UButton v-if="hasLogs(container)" size="xs" variant="ghost" @click="showLogs(container.name)">Logs</UButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </UCard>
      </section>

      <UCard v-if="selected">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">Logs of {{ selected }} (latest 300 lines)</span>
            <div class="flex gap-2">
              <UButton size="xs" variant="outline" :loading="logsLoading" @click="showLogs(selected)">Reload</UButton>
              <UButton size="xs" variant="ghost" @click="selected = undefined">Close</UButton>
            </div>
          </div>
        </template>
        <pre class="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all text-xs">{{ logs }}</pre>
      </UCard>

      <p class="text-xs text-muted">Read {{ ago(state.generatedAt) }}, refreshed every 30 seconds.</p>
    </template>
  </UContainer>
  </div>
</template>
