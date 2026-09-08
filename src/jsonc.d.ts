/** wrangler.jsonc 的 `rules` 把 .jsonc 設定成 Text module，匯入後是檔案原始內容 */
declare module '*.jsonc' {
  const content: string
  export default content
}
