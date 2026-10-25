<template>
  <div>
    <button @click="handleSelectFolder">选择图片文件夹</button>
    <p>选中路径：{{ folderPath }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const folderPath = ref('')

const handleSelectFolder = async () => {
  // 这里 window.ipcRenderer 就是你 preload 暴露出来的
  const path = await window.ipcRenderer.invoke('open-select-folder')
  if (path) {
    folderPath.value = path
  }
}
</script>
