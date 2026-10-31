/**
 * The duplicates tab: a page of the names with different files on On Page,
 * searched by name, with the labels of the things read for that page only.
 */
import { OpFile, Schema } from 'onpage-js'
import { DuplicatePage, PageQuery } from '../shared/models'
import { errorDetail } from './errors'
import { ResolvedNames } from './names'
import { thingEditUrl } from './onpage'

/** Uses shown per variant */
const MAX_USES = 20

export async function duplicatesPage(
  resolved: ResolvedNames | undefined,
  page: Partial<PageQuery>,
  schemaOf: () => Promise<Schema>,
  log: (message: string) => void,
): Promise<DuplicatePage> {
  if (!resolved?.duplicates.length)
    return { total: 0, language_variants: 0, groups: [] }
  const query = page.query?.trim().normalize('NFC').toLowerCase()
  const matching = query
    ? resolved.duplicates.filter(group => group.key.includes(query))
    : resolved.duplicates
  const offset = Math.max(0, page.offset ?? 0)
  const groups = matching.slice(offset, offset + Math.max(1, page.limit ?? 50))
  const total = {
    total: matching.length,
    language_variants: languageVariants(resolved),
  }
  if (!groups.length) return { ...total, groups: [] }
  const schema = await schemaOf()
  const lang = schema.lang ?? schema.default_lang

  // Thing labels, read only for the things involved
  const labels = new Map<number, string>()
  const by_resource = new Map<number, Set<number>>()
  for (const group of groups) {
    for (const variant of group.variants) {
      for (const use of variant.uses.slice(0, MAX_USES)) {
        let ids = by_resource.get(use.resource_id)
        if (!ids) by_resource.set(use.resource_id, (ids = new Set()))
        ids.add(use.thing_id)
      }
    }
  }
  for (const [resource_id, ids] of by_resource) {
    const resource = schema.resource(resource_id)
    const label_field = resource?.fields.find(f => f.is_textual)
    if (!resource || !label_field) continue
    const all = Array.from(ids)
    for (let i = 0; i < all.length; i += 1000) {
      try {
        const things = await resource
          .query()
          .setFields([label_field.name])
          .where('_id', 'in', all.slice(i, i + 1000))
          .all()
        for (const thing of things) {
          const value = thing.val(label_field)
          if (value !== undefined && value !== null)
            labels.set(Number(thing.id), typeof value == 'object' ? JSON.stringify(value) : String(value))
        }
      } catch (error) {
        log(`Labels not read: ${errorDetail(error)}`)
      }
    }
  }

  const label = (get: () => string | undefined, fallback: string): string => {
    try {
      return get() || fallback
    } catch {
      return fallback
    }
  }
  return {
    ...total,
    groups: groups.map(group => ({
      name: group.name,
      variants: group.variants.map(variant => {
        const file = new OpFile(
          { token: variant.token, name: variant.remote_name },
          schema.api,
        )
        return {
          token: variant.token,
          size: variant.size,
          width: variant.width,
          height: variant.height,
          thumb_url: file.isImage()
            ? file.link({ x: 100, y: 100, mode: 'contain' })
            : undefined,
          chosen: variant.chosen,
          uses: variant.uses.slice(0, MAX_USES).map(use => {
            const resource = schema.resource(use.resource_id)
            const field = schema.field(use.field_id)
            return {
              resource_label: label(
                () => resource?.getLabel(lang),
                String(use.resource_id),
              ),
              field_label: label(
                () => field?.getLabel(lang),
                String(use.field_id),
              ),
              thing_id: use.thing_id,
              thing_label: labels.get(use.thing_id),
              lang: use.lang ?? undefined,
              edit_url: thingEditUrl(
                schema.id,
                use.resource_id,
                use.thing_id,
                use.field_id,
              ),
            }
          }),
        }
      }),
    })),
  }
}

const LANGUAGE_VARIANTS = new WeakMap<ResolvedNames, number>()

/**
 * Names whose files are one field of one item in different languages (a
 * datasheet translated under the same name): counted once per listing.
 */
function languageVariants(resolved: ResolvedNames): number {
  let count = LANGUAGE_VARIANTS.get(resolved)
  if (count !== undefined) return count
  count = 0
  for (const group of resolved.duplicates) {
    const at = new Map<string, { variant: number; lang: string | null }[]>()
    let found = false
    group.variants.forEach((variant, index) => {
      for (const use of variant.uses) {
        if (found) return
        const where = `${use.resource_id}:${use.thing_id}:${use.field_id}`
        const others = at.get(where) ?? []
        if (others.some(o => o.variant != index && o.lang != use.lang)) found = true
        others.push({ variant: index, lang: use.lang })
        at.set(where, others)
      }
    })
    if (found) count++
  }
  LANGUAGE_VARIANTS.set(resolved, count)
  return count
}
