<script>
// The site's button. Extra classes on it (a width, a weight) are added to these.
//   variant  default; primary: the main action; solid: a mode that is running; quiet: a minor action in a list;
//            danger: confirms something that cannot be undone
//   on       a toggle that is on (instead of variant)
//   size     md; sm: in a list; lg: a form's submit
const BASE = 'cursor-pointer rounded-md border disabled:cursor-default disabled:opacity-50';
const VARIANT = {
  default: 'border-line bg-bg text-ink',
  on: 'border-accent bg-accent-soft text-ink',
  primary: 'border-accent bg-accent-soft font-semibold text-ink',
  solid: 'border-accent bg-accent text-white',
  quiet: 'border-line bg-bg text-muted',
  danger: 'border-warn-ink bg-warn-bg text-warn-ink'
};
const SIZE = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm', lg: 'px-3 py-2 text-sm' };

// The same look for a control that is not a button (the player's speed <select>).
export const CONTROL = `${BASE} ${SIZE.md} ${VARIANT.default}`;
</script>

<script setup>
defineProps({
  variant: { type: String, default: 'default' },
  size: { type: String, default: 'md' },
  on: Boolean
});
</script>

<template>
  <button :class="[BASE, SIZE[size], VARIANT[on ? 'on' : variant]]">
    <slot />
  </button>
</template>
