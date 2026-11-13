<script setup>
// A message that needs attention: a strip across the page, or (boxed) a box inside a form.
defineProps({ boxed: Boolean });
</script>

<template>
  <p class="bg-warn-bg py-2 text-sm text-warn-ink" :class="boxed ? 'mb-2 rounded-md px-2.5' : 'px-4'">
    <slot />
  </p>
</template>
