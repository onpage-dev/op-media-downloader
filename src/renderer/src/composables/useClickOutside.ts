/** `away` when the mouse goes down outside `target`: a menu or a list that is open closes */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export function useClickOutside(target: Ref<HTMLElement | undefined>, away: () => void): void {
  const listener = (event: MouseEvent): void => {
    if (!target.value?.contains(event.target as Node)) away()
  }
  onMounted(() => window.addEventListener('mousedown', listener, true))
  onBeforeUnmount(() => window.removeEventListener('mousedown', listener, true))
}
