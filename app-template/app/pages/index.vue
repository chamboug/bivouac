<script setup lang="ts">
const { data: user } = await useUser();
</script>

<template>
  <UContainer class="py-12 space-y-4">
    <h1 class="text-2xl font-semibold">Hello {{ user?.name }}</h1>
    <p v-if="user?.groups.length">Groups: {{ user.groups.join(", ") }}</p>
    <form method="post" action="/auth/logout">
      <UButton type="submit" variant="outline">Sign out</UButton>
    </form>
  </UContainer>
</template>
