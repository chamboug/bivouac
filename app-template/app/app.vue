<script setup lang="ts">
// The browser's own bars (Android's status bar, Safari's tab) take the page's
// background, following the theme chosen in the app, not only the phone's.
const colorMode = useColorMode();
const themeColor = ref<string>();
onMounted(() => {
  watch(
    () => colorMode.value,
    async () => {
      await nextTick();
      themeColor.value = hex(getComputedStyle(document.body).backgroundColor);
    },
    { immediate: true },
  );
});

// Nuxt UI's colours are oklch(); a plain #rrggbb is understood everywhere.
function hex(color: string): string {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
}
useHead({ meta: [{ name: "theme-color", content: themeColor }] });
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
