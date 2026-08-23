/** Bun embeds these at build time via `with { type: "text" }`. */
declare module "*.sql" {
  const content: string
  export default content
}

declare module "*.eta" {
  const content: string
  export default content
}

declare module "*.css" {
  const content: string
  export default content
}

declare module "*.js" {
  const content: string
  export default content
}
