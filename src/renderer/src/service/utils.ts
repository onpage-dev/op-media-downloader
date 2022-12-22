import { isNumber, isString } from 'lodash'
import { StorageData, UserSettings } from 'src/renderer/classes/folder-config'
import { Ref } from 'vue'
import { OpCardColor } from '../../classes/color-classes'

export function formattedColor(string: string): OpCardColor {
  const exploded = string.split('-')
  const col = exploded[0]
  const inv = exploded[1] == 'inv'
  let lum = Number(exploded[1] || 5)
  if (isNaN(lum)) lum = 5
  return {
    col,
    lum,
    inv,
    mix(diff?: number | 'inv' | 'mix'): string {
      if (isString(diff)) {
        return this.col + '-' + diff
      } else if (isNumber(diff)) {
        return this.col + '-' + (this.lum + diff)
      } else if (this.inv) {
        return this.col + '-inv'
      } else {
        return this.col + '-' + this.lum
      }
    },
  }
}

export function toggleUserProperty(
  storage: StorageData,
  key: keyof UserSettings,
  val: boolean,
): void {
  const user_props = storage.user_properties
  user_props[key] = val
  storage.user_properties = user_props
}

const object_id_map = new WeakMap()
let objectCount = 0
export function id(object: object): any {
  if (!object_id_map.has(object)) object_id_map.set(object, ++objectCount)
  return object_id_map.get(object)
}
