<template>
  <!-- Keyed, so another song is a new player. -->
  <RouterView :key="$route.fullPath" />
</template>
