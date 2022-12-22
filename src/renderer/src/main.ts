import { createApp } from 'vue'
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

app.mount('#app')
