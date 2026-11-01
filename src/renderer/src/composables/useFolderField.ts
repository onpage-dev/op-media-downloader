/**
 * The folder of a project being made or changed, in the wizard and in the
 * project's settings: the system's picker, then the inspection of what was
 * picked (network, hard links, space, problems). An answer for a folder picked
 * before is dropped. `projectId` names the project whose folder it is, so that
 * its own folder is not «used by another project».
 */
import { computed, ref, type Ref } from 'vue'
import type { FolderInfo, ProjectId } from '@shared/models'
import { inspectFolder, pickFolder } from '../store'
import { useAction } from './useAction'

export interface FolderField {
  folder: Ref<string>
  /** `inspecting` while main looks at the folder */
  info: Ref<FolderInfo | 'inspecting' | undefined>
  /** Why the picker or the inspection failed */
  error: Readonly<Ref<string | undefined>>
  pick: () => Promise<void>
  inspect: (path: string) => Promise<void>
  /** Another folder (or none) and nothing inspected */
  reset: (path?: string) => void
}

export function useFolderField(projectId?: () => ProjectId | undefined): FolderField {
  const folder = ref('')
  const info = ref<FolderInfo | 'inspecting'>()
  const picking = useAction('pick folder', pickFolder)
  const inspection = useAction('inspect folder', (path: string) => inspectFolder(path, projectId?.()))

  async function inspect(path: string): Promise<void> {
    info.value = 'inspecting'
    const result = await inspection.run(path)
    if (result && folder.value == path) info.value = result
    else if (!inspection.busy.value && info.value == 'inspecting') info.value = undefined
  }
  async function pick(): Promise<void> {
    const picked = await picking.run(folder.value || undefined)
    if (!picked) return
    folder.value = picked
    await inspect(picked)
  }
  function reset(path = ''): void {
    picking.clear()
    inspection.clear()
    folder.value = path
    info.value = undefined
  }

  return {
    folder,
    info,
    error: computed(() => picking.error.value ?? inspection.error.value),
    pick,
    inspect,
    reset,
  }
}
