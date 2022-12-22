export interface Store {
  electronStoreChanged: any
  get: (key: string) => any
  set: (key: string, val: any) => void
  has: (key: string) => boolean
  delete: (key: string) => boolean
}
