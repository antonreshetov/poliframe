interface StoreSchema {
  supporter: { key: string, exports: number }
  bounds: object
  devToolsOpen: boolean
}

export default async function createAppStore() {
  const { default: Store } = await import('electron-store')
  return new Store<StoreSchema>({
    name: 'app',
    schema: {
      supporter: {
        type: 'object',
        default: { key: '', exports: 0 },
        properties: {
          key: { type: 'string', default: '' },
          exports: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      devToolsOpen: {
        default: false,
        type: 'boolean',
      },
      bounds: {
        default: {},
        type: 'object',
      },
    },
  })
}
