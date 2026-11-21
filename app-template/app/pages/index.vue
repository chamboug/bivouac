<script setup lang="ts">
const { data: user } = await useUser();
</script>

<template>
  <UContainer class="py-6 space-y-4">
    <header class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-semibold">Hello {{ user?.name }}</h1>
      <!-- Every app keeps this choice (Automatic, light, dark): CLAUDE.md, "Interface". -->
      <UColorModeSelect class="w-36" aria-label="Theme" />
    </header>
    <p v-if="user?.groups.length">Groups: {{ user.groups.join(", ") }}</p>
    <form method="post" action="/auth/logout">
      <UButton type="submit" variant="outline">Sign out</UButton>
    </form>
  </UContainer>
</template>
