import { each, isEmpty, mapValues } from 'lodash'
import { App } from 'vue'
import OpCard from '../src/components/op-card.vue'
import OpIcon from '../src/components/op-icon.vue'
import OpSearch from '../src/components/op-search.vue'

interface CustomComponent {
  [key: string]: { component: any; props?: any }
}
export default {
  install(app: App): void {
    const components: CustomComponent = {
      'op-icon': {
        component: OpIcon,
      },
      'op-search': {
        component: OpSearch,
      },
      'op-overlay-card': {
        component: OpCard,
        props: {
          color: 'wallpaper darkwallpaper',
          bcolor: 'dark darkwallpaper-8',
          radius: 'lg',
          shadow: 'lg',
          pad: 'p-4',
          provide: true,
        },
      },
      'op-card': {
        component: OpCard,
        props: {
          color: 'box dbox',
          bcolor: '-10 -8',
          shadow: 'sm',
          col: true,
        },
      },
      'op-clickable-card': {
        component: OpCard,
        props: {
          type: 'button',
          color: 'box dbox',
          bcolor: '-10 -8',
          shadow: 'sm',
          col: true,
        },
      },
      'op-clickable-tag': {
        component: OpCard,
        props: {
          type: 'button',
          color: 'box dbox',
          bcolor: '-10 -8',
          shadow: 'sm',
          pad: 'py-unit-half px-unit-double',
          radius: 'full',
          middle: true,
          row: true,
        },
      },
      'op-solid-card': {
        component: OpCard,
        props: {
          color: 'box dbox',
          bcolor: '- -',
          col: true,
        },
      },
      'op-btn': {
        component: OpCard,
        props: {
          type: 'button',
          color: 'accent',
          radius: 'full',
          middle: true,
          row: true,
        },
      },
      'op-circle-btn': {
        component: OpCard,
        props: {
          type: 'button',
          color: 'inherit',
          radius: 'full',
          size: () => [12, 12],
          nopad: true,
          noshrink: true,
          middle: true,
          col: true,
        },
      },
      'op-submit': {
        component: OpCard,
        props: {
          type: 'submit',
          color: 'accent',
          radius: 'full',
          middle: true,
          row: true,
        },
      },
      'op-cancel': {
        component: OpCard,
        props: {
          type: 'button',
          color: 'inherit',
          tcolor: 'red',
          radius: 'full',
          middle: true,
          row: true,
        },
      },
      'op-input': {
        component: OpCard,
        props: {
          type: 'text',
          color: 'box dbox',
          bcolor: '-10 -8',
          shadow: 'sm',
        },
      },
    }

    const created: any = {}
    each(components, (c, name) => {
      if (!c.props || isEmpty(c.props)) {
        app.component(name, c.component)
      } else {
        const props = mapValues(c.props, value => ({ default: value }))
        created[name] = app.component(name, {
          extends: c.component,
          props,
        })
      }
    })
  },
}
