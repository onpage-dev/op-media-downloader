/**
 * The next page of a long list when its end comes near (600px before it is in
 * view) in the box that scrolls it: the inspector provides its scroller as
 * `SCROLLER`, the root of the observer (without it the margin would count from
 * the window). An observer only reports changes: after each page the end is
 * looked at again, in case it is still in view.
 */
import { inject, onBeforeUnmount, onMounted, watch, type InjectionKey, type Ref, type WatchSource } from 'vue'

export const SCROLLER: InjectionKey<Ref<HTMLElement | undefined>> = Symbol('scroller')

export function useInfiniteScroll(
  end: Ref<HTMLElement | undefined>,
  more: () => void,
  size: WatchSource<number>,
): void {
  const scroller = inject(SCROLLER, undefined)
  let observer: IntersectionObserver | undefined
  const look = (): void => {
    if (!observer || !end.value) return
    observer.unobserve(end.value)
    observer.observe(end.value)
  }
  onMounted(() => {
    observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) more()
      },
      { root: scroller?.value ?? null, rootMargin: '600px' },
    )
    look()
  })
  watch(size, look, { flush: 'post' })
  onBeforeUnmount(() => observer?.disconnect())
}
