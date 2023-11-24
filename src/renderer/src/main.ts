import { createApp, ref } from 'vue'
import '../styles/1-before.css'
import '../styles/2-app.scss'
import '../styles/3-after.css'

import App from './App.vue'
const app = createApp(App)

import locale from '../boot/locale'
import opComponents from '../boot/op-components'
app.use(locale)
app.use(opComponents)

import VTooltip from 'floating-vue'
app.use(VTooltip, {
  defaultBoundariesElement: 'window',
})

window.version_info = ref(undefined)
window.electron.ipcRenderer.send('getVersionInfo')
window.electron.ipcRenderer.on('version_info', (_event, data) => {
  window.version_info.value = data
})

app.mount('#app')
