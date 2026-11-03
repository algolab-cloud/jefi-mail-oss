// Bun embeds SVG text imports in the standalone executable.
declare module '*.svg' {
  const source: string
  export default source
}

// GPUIX's upstream example targets the current Bun runtime API.
declare module 'bun' {
  export const isStandaloneExecutable: boolean
}

// Raster images are embedded too; the import is a path Bun can read inside the executable.
declare module '*.png' {
  const path: string
  export default path
}
