import { resolve } from 'node:path'

/** The Jefi website repo, which takes this repo's rendered images: beside it as ../website unless JEFI_WEBSITE says otherwise. */
export const WEBSITE = resolve(process.env.JEFI_WEBSITE ?? resolve(import.meta.dir, '../../website'))
