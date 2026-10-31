/**
 * What the listing found on On Page, and its cache on the local disk
 * (userData/cache/<project>.json.gz) for incremental listings.
 */
import { promisify } from 'util'
import { gunzip, gzip } from 'zlib'
import { promises as fs } from 'fs'
import { atomicWrite } from './fsx'

/** [field_id, lang | null, remote name, token, size | null, width | null, height | null] */
export type RemoteFileTuple = [
  number,
  string | null,
  string,
  string,
  number | null,
  number | null,
  number | null,
]

export interface RemoteResource {
  id: number
  /** Thing id → its files, in field, lang and value order */
  things: Map<number, RemoteFileTuple[]>
}

export interface RemoteIndex {
  schema_id: number
  signature: string
  /** Server time when the last complete listing started (ISO) */
  checkpoint: string
  /** Resources with media fields, in schema order */
  resources: RemoteResource[]
}

interface CacheJson {
  version: 1
  schema_id: number
  signature: string
  checkpoint: string
  written_at: string
  resources: { id: number; things: [number, RemoteFileTuple[]][] }[]
}

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export async function readIndexCache(
  file: string,
): Promise<RemoteIndex | undefined> {
  let raw: Buffer
  try {
    raw = await fs.readFile(file)
  } catch {
    return undefined
  }
  try {
    const json = JSON.parse(
      (await gunzipAsync(raw)).toString('utf8'),
    ) as CacheJson
    if (json.version != 1 || !Array.isArray(json.resources)) return undefined
    return {
      schema_id: json.schema_id,
      signature: json.signature,
      checkpoint: json.checkpoint,
      resources: json.resources.map(r => ({
        id: r.id,
        things: new Map(r.things),
      })),
    }
  } catch {
    // A broken cache only costs a full listing
    return undefined
  }
}

export async function writeIndexCache(
  file: string,
  index: RemoteIndex,
): Promise<void> {
  const json: CacheJson = {
    version: 1,
    schema_id: index.schema_id,
    signature: index.signature,
    checkpoint: index.checkpoint,
    written_at: new Date().toISOString(),
    resources: index.resources.map(r => ({
      id: r.id,
      things: Array.from(r.things.entries()),
    })),
  }
  await atomicWrite(file, await gzipAsync(Buffer.from(JSON.stringify(json))))
}

export function countFiles(index: RemoteIndex): number {
  let n = 0
  for (const r of index.resources)
    for (const files of r.things.values()) n += files.length
  return n
}
